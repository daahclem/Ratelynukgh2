require("dotenv").config();
const fs = require("fs");
const { chromium } = require("playwright");

const INGEST_URL = process.env.INGEST_URL;
const INGEST_TOKEN = process.env.INGEST_TOKEN;
const HEADLESS = true; // set true in GitHub Actions later

function currencyForDestination(destination) {
  if (destination === "GH") return "GHS";
  if (destination === "NG") return "NGN";
  return "GHS";
}

async function postQuote(payload) {
  if (
    !INGEST_URL ||
    !INGEST_TOKEN ||
    INGEST_URL.includes("your-quoteops-app-url") ||
    INGEST_TOKEN.includes("your_secret_token_here")
  ) {
    console.log("INGEST_URL or INGEST_TOKEN not set. Quote extracted locally only:");
    console.log(payload);
    return;
  }

  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ingest failed: ${res.status} ${text}`);
  }
}

function saveDebugText(provider, text) {
  const safe = provider
    .replace(/\s+/g, "-")
    .toLowerCase();

  const file = `debug-${safe}.txt`;

  fs.writeFileSync(
    file,
    String(text || ""),
    "utf8"
  );

  return file;
}

async function saveScreenshot(page, provider) {
  const safe = provider.replace(/\s+/g, "-").toLowerCase();
  const file = `debug-${safe}.png`;

  try {
    await page.screenshot({
      path: file,
      fullPage: false,
      timeout: 10000,
    });
    return file;
  } catch (err) {
    console.error(`Could not capture screenshot for ${provider}: ${err.message}`);
    return "screenshot-not-captured";
  }
}

function parseLocaleNumber(value) {
  if (value === null || value === undefined) return null;

  let str = String(value).trim();
  if (!str) return null;

  str = str.replace(/[^\d,.-]/g, "");

  const hasComma = str.includes(",");
  const hasDot = str.includes(".");

  if (hasComma && hasDot) {
    const lastComma = str.lastIndexOf(",");
    const lastDot = str.lastIndexOf(".");

    if (lastComma > lastDot) {
      str = str.replace(/\./g, "").replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasComma) {
    if (/,\d{1,2}$/.test(str)) {
      str = str.replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasDot) {
    const parts = str.split(".");
    if (parts.length > 2) {
      const decimal = parts.pop();
      str = parts.join("") + "." + decimal;
    }
  }

  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

function extractRateFromText(text, currency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`1\\s*GBP\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`GBP\\s*1\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`Exchange Rate\\s*1\\s*GBP\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`Today[’']s rate:\\s*1(?:\\.00)?\\s*GBP\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`rate:?\\s*1\\s*GBP\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`([0-9]+(?:\\.[0-9]+)?)\\s*${currency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0 && value < 100) {
        return value;
      }
    }
  }

  return null;
}

function extractFeeFromText(text, sourceCurrency = "GBP") {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Transfer fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Zero`, "i"),
    new RegExp(`No transfer fees`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (!match) continue;
    if (/Zero/i.test(match[0]) || /No transfer fees/i.test(match[0])) return 0;
    if (match[1]) return Number(match[1]);
  }

  return 0;
}

function extractAmountReceivedFromText(text, currency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Recipient gets\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`They get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You receive\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`Receive amount\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`([0-9.]+)\\s*${currency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match && match[1]) return Number(match[1]);
  }

  return null;
}

function buildPayloadFromText(source, bodyText) {
  const currency = currencyForDestination(source.destination);
  const sendAmount = Number(source.send_amount || 1);

  let rate = extractRateFromText(bodyText, currency);
  const fee = extractFeeFromText(bodyText, "GBP");
  let amountReceived = extractAmountReceivedFromText(bodyText, currency);

  if (!rate && amountReceived && sendAmount > 0) {
    rate = Number((amountReceived / sendAmount).toFixed(6));
  }

  if (!amountReceived && rate) {
    amountReceived = Number((rate * sendAmount).toFixed(3));
  }

  if (!rate || !amountReceived) return null;

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: sendAmount,
    exchange_rate: rate,
    fee,
    amount_received: Number(amountReceived.toFixed(3)),
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}

function buildResult(source, rate, fee = 0, amountReceived = null, extra = {}) {
  const sendAmount = Number(source.send_amount || 1);
  const normalizedAmountReceived =
    amountReceived !== null && amountReceived !== undefined
      ? Number(Number(amountReceived).toFixed(6))
      : Number(Number(rate).toFixed(6));

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: sendAmount,
    exchange_rate: Number(Number(rate).toFixed(6)),
    fee: Number(Number(fee || 0).toFixed(6)),
    amount_received: normalizedAmountReceived,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
    ...extra,
  };
}

async function collectPageText(page) {
  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");

  const elementData = await page
    .locator("input, output, span, p, div, label")
    .evaluateAll((elements) =>
      elements
        .map((element) => {
          const text = element.textContent || "";
          const value =
            element instanceof HTMLInputElement
              ? element.value
              : "";

          const ariaLabel =
            element.getAttribute("aria-label") || "";

          return `${text} ${value} ${ariaLabel}`;
        })
        .join("\n")
    )
    .catch(() => "");

  return `${bodyText}\n${elementData}`;
}

function extractGbpGhsRate(text) {
  const cleaned = String(text)
    .replace(/,/g, "")
    .replace(/\s+/g, " ");

  const patterns = [
    /Exchange\s*rate\s*1(?:\.00)?\s*GBP\s*[=≈]\s*([0-9.]+)\s*GHS/i,
    /Rate\s*1(?:\.00)?\s*GBP\s*[=≈]\s*([0-9.]+)\s*GHS/i,
    /1(?:\.00)?\s*GBP\s*[=≈]\s*([0-9.]+)\s*GHS/i,
    /GBP\s*[=≈]\s*([0-9.]+)\s*GHS/i,
    /GBP\s*\/\s*GHS\s*([0-9.]+)/i,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);

    if (!match) continue;

    const candidate = parseLocaleNumber(match[1]);

    if (candidate && candidate >= 10 && candidate <= 25) {
      return Number(candidate.toFixed(6));
    }
  }

  /*
   * Some websites display:
   * 100 GBP = 1,520 GHS
   */
  const hundredMatch = cleaned.match(
    /100(?:\.00)?\s*GBP\s*[=≈]\s*([0-9.]+)\s*GHS/i
  );

  if (hundredMatch) {
    const total = parseLocaleNumber(hundredMatch[1]);

    if (total) {
      const rate = total / 100;

      if (rate >= 10 && rate <= 25) {
        return Number(rate.toFixed(6));
      }
    }
  }

  return null;
}
async function handleAfripay(page, source) {
  await page.goto("https://afripay.uk/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page.locator("#ddlcountry").selectOption("104");
  await page.waitForTimeout(1000);

  await page
    .getByRole("link", { name: /Proceed with Sending Payment/i })
    .click();

  await page.waitForTimeout(3000);

  const amountInput = page.locator("#txtAmount");
  await amountInput.waitFor({ timeout: 10000 });
  await amountInput.click();
  await amountInput.fill("1");

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let payload = buildPayloadFromText(source, bodyText);

  if (!payload) {
    let rate = null;

    const patterns = [
      /Exchange Rate[^0-9]*1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
      /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
      /\b(1[0-9]\.\d{2,4})\b/,
    ];

    for (const regex of patterns) {
      const match = bodyText.match(regex);
      if (!match) continue;
      rate = parseFloat(match[1] || match[0]);
      if (!Number.isNaN(rate) && rate > 0) break;
    }

    if (rate) {
      payload = {
        provider_name: source.provider,
        origin_country: source.origin,
        destination_country: source.destination,
        payout_method: source.payout_method,
        send_amount: 1,
        exchange_rate: rate,
        fee: 0,
        amount_received: Number(rate.toFixed(3)),
        delivery_speed: null,
        source_type: "browser_automation",
        verification_status: "verified_from_quote_page",
        source_url: source.url,
        checked_at: new Date().toISOString(),
      };
    }
  }

  if (!payload) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Afripay rate. Screenshot: ${file}`);
  }

  return payload;
}

async function handleContinentalMoney(page, source) {
  await page.goto("https://www.continental.money/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  // Sending currency = GBP
  await page.getByText("GBP GBP").click({ timeout: 5000 }).catch(() => {});
  await page.getByRole("option", { name: "GBP GBP" }).click({ timeout: 5000 }).catch(() => {});

  await page.waitForTimeout(1000);

  // Receiving currency = GHS
  await page.getByText("GHS").nth(2).click({ timeout: 5000 }).catch(async () => {
    await page.getByText("GHS GHS").click({ timeout: 5000 }).catch(() => {});
  });
  await page.getByRole("option", { name: "GHS GHS" }).click({ timeout: 5000 }).catch(() => {});

  await page.waitForTimeout(1000);

  const sendInput = page.getByRole("spinbutton", { name: /I'm sending/i });
  await sendInput.waitFor({ timeout: 10000 });
  await sendInput.click({ force: true });
  await sendInput.press("Control+A").catch(() => {});
  await sendInput.fill("100");

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  // First try explicit rate patterns
  const explicitPatterns = [
    /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /GBP\s*1\s*=\s*([0-9.]+)\s*GHS/i,
    /([0-9]+(?:\.[0-9]+)?)\s*GHS/i,
  ];

  for (const regex of explicitPatterns) {
    const match = bodyText.match(regex);
    if (!match) continue;

    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate >= 10 && candidate <= 20) {
      rate = candidate;
      break;
    }
  }

  // Loose fallback only if explicit extraction failed
  if (!rate) {
    const looseMatches = bodyText.match(/\b1[0-9]\.\d{1,5}\b/g) || [];
    const candidates = looseMatches
      .map((v) => parseFloat(v))
      .filter((v) => !Number.isNaN(v) && v >= 10 && v <= 20);

    if (candidates.length) {
      rate = candidates[0];
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Continental Money rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate, {
    quoted_send_amount: 100,
  });
}

async function handleFPTransfer(page, source) {
  await page.goto("https://fastpacetransfer.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page.getByRole("link", { name: /Remittances/i }).click().catch(() => {});
  await page.waitForTimeout(2000);

  await page.locator("#top").getByRole("combobox").selectOption("uk").catch(() => {});
  await page.goto("https://fastpacetransfer.com/remittances/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  const sendInput = page.getByRole("spinbutton", { name: /You Send/i });
  await sendInput.waitFor({ timeout: 10000 });
  await sendInput.click({ force: true });
  await sendInput.press("Control+A").catch(() => {});
  await sendInput.fill("100");

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /Exchange Rate:\s*1\s*GBP\s*=\s*([0-9.]+)/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /\b(1[0-9]\.\d{1,5})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 10 && candidate <= 20) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract FP Transfer rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate, {
    quoted_send_amount: 100,
  });
}

async function handleInstarem(page, source) {
  await page.goto("https://www.instarem.com/en-gb/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page
    .locator(".widget-calculator__dropdown-main-right")
    .first()
    .click();

  const searchBox1 = page.getByRole("textbox", {
    name: /Search country or currency/i,
  });
  await searchBox1.waitFor({ timeout: 10000 });
  await searchBox1.fill("gb");
  await page.getByText("United Kingdom").nth(1).click();

  await page.waitForTimeout(1500);

  await page
    .locator(".widget-calculator__recive > .widget-calculator__dropdown > .widget-calculator__dropdown-main > .widget-calculator__dropdown-main-right")
    .click();

  const searchBox2 = page.getByRole("textbox", {
    name: /Search country or currency/i,
  });
  await searchBox2.fill("gh");
  await page.getByText("Ghana GHS").click();

  await page.waitForTimeout(1500);

  const sendInput = page.getByRole("textbox", { name: /You send/i });
  await sendInput.click();
  await sendInput.fill("1");

  await page.waitForTimeout(6000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let payload = buildPayloadFromText(source, bodyText);

  if (!payload) {
    let rate = null;

    const patterns = [
      /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
      /([0-9.]+)\s*GHS/i,
      /\b(1[0-9]\.\d{2,4})\b/,
    ];

    for (const regex of patterns) {
      const match = bodyText.match(regex);
      if (!match) continue;
      rate = parseFloat(match[1] || match[0]);
      if (!Number.isNaN(rate) && rate > 0) break;
    }

    if (rate) {
      payload = {
        provider_name: source.provider,
        origin_country: source.origin,
        destination_country: source.destination,
        payout_method: source.payout_method,
        send_amount: 1,
        exchange_rate: rate,
        fee: 0,
        amount_received: Number(rate.toFixed(3)),
        delivery_speed: null,
        source_type: "browser_automation",
        verification_status: "verified_from_quote_page",
        source_url: source.url,
        checked_at: new Date().toISOString(),
      };
    }
  }

  if (!payload) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Instarem rate. Screenshot: ${file}`);
  }

  return payload;
}

async function handleJupay(page, source) {
  await page.goto("https://jupay.co/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.locator("#country").first().selectOption("GBP");
  await page.waitForTimeout(1500);

  const scrapeAmount = 100;

  const sendInput = page.getByRole("textbox", { name: /You send/i });
  await sendInput.waitFor({ timeout: 10000 });
  await sendInput.click();
  await sendInput.fill(String(scrapeAmount));

  await page
    .locator("div")
    .filter({ hasText: /Simple Fast Money Transfer/i })
    .nth(2)
    .click()
    .catch(() => {});
  await page.keyboard.press("Tab").catch(() => {});

  await page.waitForTimeout(6000);

  const receiveInput = page.getByRole("textbox", { name: /Recipient gets/i });

  let amountReceivedTotal = null;
  if (await receiveInput.count()) {
    const rawReceive = await receiveInput.inputValue().catch(() => "");
    const parsed = parseLocaleNumber(rawReceive);
    if (parsed && parsed > 0) amountReceivedTotal = parsed;
  }

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  if (amountReceivedTotal && scrapeAmount > 0) {
    rate = Number((amountReceivedTotal / scrapeAmount).toFixed(6));
  }

  if (!rate) {
    const patterns = [
      /Exchange Rate:\s*([0-9.]+)\s*Fees:/i,
      /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
      /GBP\s*=\s*([0-9.]+)\s*GHS/i,
      /\b(1[0-9]\.\d{2,5})\b/,
    ];

    for (const regex of patterns) {
      const match = bodyText.match(regex);
      if (!match) continue;
      const candidate = parseLocaleNumber(match[1] || match[0]);
      if (candidate && candidate > 0) {
        rate = Number(candidate.toFixed(6));
        break;
      }
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Jupay rate. Screenshot: ${file}`);
  }

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: Number(rate.toFixed(6)),
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
    quoted_send_amount: scrapeAmount,
    quoted_amount_received: amountReceivedTotal,
  };
}

async function handleOaPay(page, source) {
  await page.goto("https://www.oapay.co/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByText("GBP").nth(1).click().catch(() => {});
  await page.getByText("GBP United Kingdom").click().catch(() => {});

  await page.waitForTimeout(1200);

  await page.getByText("GHS").nth(2).click().catch(() => {});
  await page.getByText("GHS Ghana").click().catch(() => {});

  await page.waitForTimeout(1500);

  const sendOrReceiveBox = page.getByRole("textbox", { name: /Recipient Receives/i });
  await sendOrReceiveBox.waitFor({ timeout: 10000 });
  await sendOrReceiveBox.click();
  await sendOrReceiveBox.fill("1");

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /GBP\s*=\s*([0-9.]+)\s*GHS\s*\(no charges\)/i,
    /1\.00\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /\b(1[0-9]\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract OaPay rate. Screenshot: ${file}`);
  }

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: Number(rate.toFixed(6)),
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}

async function handleOhentPay(page, source) {
  await page.goto("https://www.ohentpay.com/en-GB", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page
    .getByRole("button", { name: /Accept/i })
    .click({ timeout: 4000 })
    .catch(() => {});

  await page
    .getByRole("link", { name: /See rates/i })
    .click({ timeout: 20000 });

  await page.waitForTimeout(2500);

  const currencySelectors = [
    page.getByRole("combobox").filter({ hasText: /USD/i }).first(),
    page.getByRole("combobox").first(),
    page.locator('[role="combobox"]').first(),
  ];

  let currencyOpened = false;

  for (const selector of currencySelectors) {
    try {
      if (await selector.isVisible({ timeout: 3000 })) {
        await selector.click({
          timeout: 5000,
          force: true,
        });

        currencyOpened = true;
        break;
      }
    } catch (_) {}
  }

  if (!currencyOpened) {
    const file = await saveScreenshot(page, source.provider);

    throw new Error(
      `Ohent Pay currency selector could not be opened. Screenshot: ${file}`
    );
  }

  await page
    .getByText(/Ghanaian cedi\s*\(GHS\)/i)
    .first()
    .click({
      timeout: 15000,
      force: true,
    });

  await page.waitForTimeout(5000);

  let rateText = "";

  const rateParagraph = page
    .getByRole("paragraph")
    .filter({
      hasText: /Exchange rate/i,
    })
    .first();

  if (await rateParagraph.count()) {
    rateText = await rateParagraph
      .innerText()
      .catch(() => "");
  }

  if (!rateText) {
    rateText = await page
      .getByText(/Exchange rate/i)
      .first()
      .textContent()
      .catch(() => "");
  }

  const pageText = await collectPageText(page);
  const combinedText = `${rateText}\n${pageText}`;

  saveDebugText(source.provider, combinedText);

  let rate = extractGbpGhsRate(combinedText);

  /*
   * Ohent Pay may display a sentence resembling:
   * "Exchange rate 100 GBP = 15.20..."
   *
   * In that case, 15.20 is already likely the unit rate rather
   * than the amount received for £100. Accept it only when it is
   * within the realistic GBP/GHS range.
   */
  if (!rate) {
    const ohentMatch = combinedText.match(
      /Exchange\s*rate[^0-9]*100\s*GBP[^0-9]*([0-9]+(?:\.[0-9]+)?)/i
    );

    if (ohentMatch) {
      const candidate = parseLocaleNumber(
        ohentMatch[1]
      );

      if (
        candidate &&
        candidate >= 10 &&
        candidate <= 25
      ) {
        rate = Number(candidate.toFixed(6));
      } else if (
        candidate &&
        candidate >= 1000 &&
        candidate <= 2500
      ) {
        rate = Number(
          (candidate / 100).toFixed(6)
        );
      }
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);

    throw new Error(
      `Could not extract Ohent Pay rate. ` +
      `Captured text: ${combinedText
        .replace(/\s+/g, " ")
        .slice(0, 300)}. ` +
      `Screenshot: ${file}`
    );
  }

  return buildResult(source, rate, 0, rate, {
    verified_method: "ohent_rate_text",
  });
}

async function handlePadiePay(page, source) {
  await page.goto("https://www.padiepay.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page
    .getByRole("button", { name: "Maybe, later" })
    .click({ timeout: 8000 })
    .catch(() => {});

  await page
    .getByRole("button", { name: "🇺🇸 USD" })
    .click({ timeout: 15000 });

  await page
    .getByText("British Pound Sterling", { exact: true })
    .click({ timeout: 15000 });

  await page.waitForTimeout(1000);

  await page
    .getByRole("button", { name: "🇳🇬 NGN" })
    .click({ timeout: 15000 });

  await page
    .getByText("Ghanaian Cedi", { exact: true })
    .click({ timeout: 15000 });

  await page.waitForTimeout(4000);

  const rateText = await page
    .getByText(/GBP\s*=\s*[0-9.]+\s*GHS/i)
    .first()
    .innerText()
    .catch(() => "");

  const bodyText = `${rateText}\n${await page.locator("body").innerText()}`;

  saveDebugText(source.provider, bodyText);

  const match = bodyText.match(
    /GBP\s*=\s*([0-9.]+)\s*GHS/i
  );

  const rate = match ? parseLocaleNumber(match[1]) : null;

  if (!rate || rate < 10 || rate > 25) {
    const file = await saveScreenshot(page, source.provider);

    throw new Error(
      `Could not extract PadiePay rate. Screenshot: ${file}`
    );
  }

  return buildResult(source, rate, 0, rate);
}

async function handlePaysend(page, source) {
  await page.goto("https://paysend.com/en-gb", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("button", { name: /Accept All Cookies/i }).click({ timeout: 6000 }).catch(() => {});

  await page.locator("a").filter({ hasText: /^GBP$/ }).click({ timeout: 8000 }).catch(() => {});
  let searchBox = page.getByPlaceholder("Search for a country");
  await searchBox.waitFor({ timeout: 10000 });
  await searchBox.fill("gb");
  await page.waitForTimeout(1000);
  await page.getByText(/United KingdomGBP/i).click().catch(() => {});

  await page.waitForTimeout(1500);

  await page.locator("a").filter({ hasText: /^[A-Z]{3}$/ }).nth(1).click().catch(() => {});
  searchBox = page.getByPlaceholder("Search for a country");
  await searchBox.fill("gh");
  await page.waitForTimeout(1000);

  await page.getByText(/GhanaGHSUSD/i).click().catch(() => {});
  await page.getByText(/Ghana CediGHS/i).click().catch(() => {});

  await page.waitForTimeout(2500);

  for (let i = 0; i < 3; i++) {
    await page.locator("a").filter({ hasText: /^OK$/ }).click({ timeout: 2500 }).catch(() => {});
    await page.waitForTimeout(800);
  }

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /Today[’']s rate:\s*1\.00\s*GBP\s*=\s*([0-9.]+)/i,
    /1\.00\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /\b(1[0-9]\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 10 && candidate <= 20) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Paysend rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function runSource(browser, source) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
  });

  try {
    let payload;

    if (source.provider === "Afripay") payload = await handleAfripay(page, source);
    else if (source.provider === "Continental Money") payload = await handleContinentalMoney(page, source);
    else if (source.provider === "FP Transfer") payload = await handleFPTransfer(page, source);
    else if (source.provider === "Instarem") payload = await handleInstarem(page, source);
    else if (source.provider === "JubaExpress") payload = await handleJubaExpress(page, source);
    else if (source.provider === "Jupay") payload = await handleJupay(page, source);
    else if (source.provider === "OaPay") payload = await handleOaPay(page, source);
    else if (source.provider === "Ohent Pay") payload = await handleOhentPay(page, source);
    else if (source.provider === "PadiePay") payload = await handlePadiePay(page, source);
    else if (source.provider === "Paysend") payload = await handlePaysend(page, source);
       else throw new Error(`No handler configured for ${source.provider}`);
    await postQuote(payload);
    console.log(`OK: ${source.provider} ${source.origin}->${source.destination}`);
  } finally {
    await page.close();
  }
}

async function main() {
  const sources = JSON.parse(fs.readFileSync("./sources2.json", "utf8"));
  const browser = await chromium.launch({ headless: HEADLESS });

  for (const source of sources) {
    try {
      await runSource(browser, source);
    } catch (err) {
      console.error(`FAIL: ${source.provider} - ${err.message}`);
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});