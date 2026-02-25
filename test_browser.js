const puppeteer = require('puppeteer');

(async () => {
  let browser;
  try {
    console.log("Launching browser...");
    browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    console.log("Browser launched. Connecting to page...");
    const page = await browser.newPage();
    
    console.log("Navigating to example.com...");
    await page.goto('https://example.com');
    
    console.log("Success! Page title:", await page.title());
  } catch (error) {
    console.error("Browser launch or connection failed:", error);
  } finally {
    if (browser) await browser.close();
  }
})();
