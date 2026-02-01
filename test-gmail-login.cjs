const { chromium } = require("playwright");

void (async () => {
  console.log("🚀 启动浏览器...");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("📧 打开 Gmail...");
  await page.goto("https://gmail.com");

  // 截图看看当前状态
  await page.screenshot({ path: "/Users/mbp-2013/.openclaw/gmail-login-step1.png" });
  console.log("📸 截图保存到 gmail-login-step1.png");

  // 找登录按钮
  const signInBtn = await page.$('a[href*="accounts.google.com/signin"]');
  if (signInBtn) {
    console.log("找到登录入口，点击...");
    await signInBtn.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: "/Users/mbp-2013/.openclaw/gmail-login-step2.png" });
    console.log("📸 截图保存到 gmail-login-step2.png");
  } else {
    console.log("没找到登录按钮，检查页面结构...");
    const title = await page.title();
    console.log("页面标题:", title);
  }

  await browser.close();
  console.log("✅ 完成！");
})();
