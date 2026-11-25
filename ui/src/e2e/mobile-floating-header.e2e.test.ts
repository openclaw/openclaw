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

      // The page keeps its description and its heading for assistive tech.
      await page.locator("main.content .page-subtitle").waitFor();

      // Content scrolls beneath the header, and taps on the fade reach the page.
      const content = page.locator("main.content");
      expect(
        await page.evaluate(() => document.elementFromPoint(195, 60)?.closest(".topbar")),
      ).toBe(null);

      // The header follows the shell below a notch.
      const inset = await page.addStyleTag({
        content: ":root { --safe-area-top: 47px !important; }",
      });
      await expect
        .poll(async () => (await page.locator(".topbar-nav-toggle").boundingBox())?.y)
        .toBe(toggle.y + 47);
      await inset.evaluate((style) => style.parentNode?.removeChild(style));

      await page.locator(".topbar-search").click();
      await page.locator("openclaw-command-palette [role='dialog']").first().waitFor();
      await page.keyboard.press("Escape");

      const titleBefore = await title.boundingBox();
      const contentBefore = await content.boundingBox();
      await gateway.setOnline(false);
      const notice = page.locator(".topbar .mobile-header__notices");
      await notice.waitFor();
      expect(await page.locator(".topbar .gateway-status-dot").count()).toBe(0);
      expect(await content.boundingBox()).toEqual(contentBefore);
      expect(await title.boundingBox()).toEqual(titleBefore);
      await gateway.setOnline(true);
      await expect.poll(() => notice.count()).toBe(0);
    });
  });

  it("truncates a title with no room left before it reaches the pill", async () => {
    await suite.withPage({ viewport: { width: 280, height: 700 } }, async ({ page }) => {
      await installMockGateway(page, { sessionKey });
      await page.goto(suite.server.baseUrl + "settings/cloud-workers");
      const title = page.locator(".topbar-page-title");
      await title.waitFor();
      const box = (await title.boundingBox())!;
      const pill = (await page.locator(".topnav-shell__actions").boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(pill.x);
      expect(await title.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
        true,
      );
    });
  });

  it("keeps a long title whole without an empty action slot at the narrowest phone", async () => {
    await suite.withPage({ viewport: { width: 320, height: 700 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, { sessionKey });
      await page.goto(suite.server.baseUrl + "settings/cloud-workers");
      const title = page.locator(".topbar-page-title");
      await title.waitFor();
      const box = (await title.boundingBox())!;
      const pill = (await page.locator(".topnav-shell__actions").boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(pill.x);
      expect(await title.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
        false,
      );

      const newSession = (await page.locator(".header-new-session").boundingBox())!;
      expect(newSession.x - pill.x).toBeCloseTo(3);

      // The notice leaves the long title where it was.
      await gateway.setOnline(false);
      const notice = page.locator(".topbar .mobile-header__notices");
      await notice.waitFor();
      expect(await title.boundingBox()).toEqual(box);
      await gateway.setOnline(true);
      await expect.poll(() => notice.count()).toBe(0);

      await page.goto(suite.server.baseUrl + "usage");
      const action = page.locator(".topnav-shell__page-actions .usage-phone-actions__trigger");
      await action.waitFor();
      expect(await page.locator(".header-new-session").boundingBox()).toEqual(newSession);
      const joinedPill = (await page.locator(".topnav-shell__actions").boundingBox())!;
      expect((await action.boundingBox())!.x - joinedPill.x).toBeCloseTo(3);
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
