import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:main";

suite.define(() => {
  it("floats the phone header over the page and reports connection through its notice", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, { sessionKey });
      await page.goto(suite.server.baseUrl + "sessions");
      const title = page.locator(".topbar-page-title");
      await title.waitFor();
      expect(await title.textContent()).toBe("Sessions");
      expect(await page.locator(".topbar-brand, .topbar .gateway-status-dot").count()).toBe(0);

      const toggle = (await page.locator(".topbar-nav-toggle").boundingBox())!;
      const pill = (await page.locator(".topnav-shell__actions").boundingBox())!;
      const titleBox = (await title.boundingBox())!;
      expect(toggle).toEqual({ x: 16, y: 8, width: 45, height: 45 });
      expect(pill.height).toBe(45);
      expect(pill.x + pill.width).toBe(374);
      expect(Math.abs(titleBox.x + titleBox.width / 2 - 195)).toBeLessThan(1);

      // The page keeps its description and its heading for assistive tech.
      await page.locator("main.content .page-subtitle").waitFor();
      expect((await page.locator("main.content .page-title").boundingBox())?.width).toBe(1);

      // Content scrolls beneath the header, and taps on the fade reach the page.
      const content = page.locator("main.content");
      expect(await content.evaluate((main) => getComputedStyle(main).paddingTop)).toBe("64px");
      expect(
        await page.evaluate(() => document.elementFromPoint(195, 60)?.closest(".topbar")),
      ).toBe(null);

      // The header follows the shell below a notch.
      const inset = await page.addStyleTag({
        content: ":root { --safe-area-top: 47px !important; }",
      });
      await expect
        .poll(async () => (await page.locator(".topbar-nav-toggle").boundingBox())?.y)
        .toBe(55);
      await inset.evaluate((style) => style.remove());

      await page.locator(".topbar-search").click();
      await page.locator("openclaw-command-palette [role='dialog']").first().waitFor();
      await page.keyboard.press("Escape");

      await gateway.setOnline(false);
      const notice = page.locator(".topbar .mobile-header__notices");
      await notice.waitFor();
      expect(await page.locator(".topbar .gateway-status-dot").count()).toBe(0);
      // It takes the title's slot: inside the header row, clear of its controls, moving nothing.
      const noticeBox = (await notice.boundingBox())!;
      expect(noticeBox.y).toBeGreaterThanOrEqual(8);
      expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual(53);
      expect(noticeBox.x).toBeGreaterThan(toggle.x + toggle.width);
      expect(noticeBox.x + noticeBox.width).toBeLessThan(pill.x);
      expect(await content.evaluate((main) => getComputedStyle(main).paddingTop)).toBe("64px");
      expect(await title.textContent()).toBe("Sessions");
      expect((await title.boundingBox())?.width).toBe(1);
      await gateway.setOnline(true);
      await expect.poll(() => notice.count()).toBe(0);
      await expect.poll(async () => (await title.boundingBox())?.width).toBeGreaterThan(1);
    });
  });

  it("truncates a long title before it reaches the pill", async () => {
    await suite.withPage({ viewport: { width: 320, height: 700 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, { sessionKey });
      await page.goto(suite.server.baseUrl + "settings/cloud-workers");
      const title = page.locator(".topbar-page-title");
      await title.waitFor();
      const box = (await title.boundingBox())!;
      const pill = (await page.locator(".topnav-shell__actions").boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(pill.x - 8);
      expect(await title.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
        true,
      );

      // The notice fits the same slot, and the long title comes back as it was.
      const toggle = (await page.locator(".topbar-nav-toggle").boundingBox())!;
      await gateway.setOnline(false);
      const notice = page.locator(".topbar .mobile-header__notices");
      await notice.waitFor();
      const noticeBox = (await notice.boundingBox())!;
      expect(noticeBox.x).toBeGreaterThan(toggle.x + toggle.width);
      expect(noticeBox.x + noticeBox.width).toBeLessThan(pill.x);
      await gateway.setOnline(true);
      await expect.poll(() => notice.count()).toBe(0);
      await expect.poll(() => title.boundingBox()).toEqual(box);
    });
  });

  it("keeps the topbar row above phone width", async () => {
    await suite.withPage({ viewport: { width: 768, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, { sessionKey });
      await page.goto(suite.server.baseUrl + "sessions");
      await page.locator(".topbar-brand").waitFor();
      expect(await page.locator(".shell--floating-header, .topbar-page-title").count()).toBe(0);
      await page.locator("main.content .page-title").waitFor();
      expect((await page.locator("main.content .page-title").boundingBox())?.width).toBeGreaterThan(
        1,
      );
    });
  });
});
