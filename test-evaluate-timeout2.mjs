import { chromium } from "playwright-core";

const CDP_URL = "http://127.0.0.1:18800";

async function test() {
  console.log("Connecting to chromium...");
  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 10000 });
  const contexts = browser.contexts();
  const pages = contexts.flatMap((c) => c.pages());
  let page = pages[0];
  if (!page) {
    page = await contexts[0].newPage();
  }

  await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 15000 });
  console.log("Navigated to example.com");

  // Test 1: Short evaluate
  console.log("\n--- Test 1: Short evaluate ---");
  try {
    const r = await page.evaluate(() => document.title);
    console.log("✅ Result:", r);
  } catch (e) {
    console.log("❌", e.message.slice(0, 100));
  }

  // Test 2: Long evaluate — use browser-level timeout wrapping
  console.log("\n--- Test 2: Long async evaluate with browser-level timeout (5s) ---");
  const start = Date.now();
  try {
    // Simulate what we'd do: inject timeout into the browser
    const result = await page.evaluate(async () => {
      return Promise.race([
        (async () => {
          await new Promise((r) => setTimeout(r, 30000));
          return "too slow";
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("evaluate timed out")), 5000)),
      ]);
    });
    console.log("❌ Should have timed out, got:", result, `(${Date.now() - start}ms)`);
  } catch (e) {
    console.log(`✅ Timed out correctly (${Date.now() - start}ms):`, e.message.slice(0, 100));
  }

  // Test 3: Page still works?
  console.log("\n--- Test 3: Page still usable? ---");
  try {
    const r = await page.evaluate(() => document.title, { timeout: 5000 });
    console.log("✅ Page works! Title:", r);
  } catch (e) {
    console.log("❌ Page stuck:", e.message.slice(0, 100));
  }

  // Test 4: Navigate?
  console.log("\n--- Test 4: Navigate? ---");
  try {
    await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 10000 });
    console.log("✅ Navigate works!");
  } catch (e) {
    console.log("❌ Navigate stuck:", e.message.slice(0, 100));
  }

  await browser.close();
  console.log("\nDone!");
}

test().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
