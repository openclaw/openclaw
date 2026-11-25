import { webkit, type Browser } from "playwright";
import { expect, it } from "vitest";
import { controlUiE2eWaitTimeoutMs, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

// openclaw/openclaw#196820: WebKit never finished style resolution when an overlay left the
// top layer while it still tried position fallbacks, freezing the whole Control UI.

let webkitBrowser: Browser | undefined;
const suite = createControlUiE2eSuite({
  name: "overlay swap in WebKit",
  resources: {
    async run() {
      webkitBrowser = await webkit.launch();
    },
    async close() {
      await webkitBrowser?.close();
    },
  },
});

suite.define(() => {
  it("keeps WebKit responsive when a rail tooltip hands off to a pinned page's tooltip", async () => {
    const context = await webkitBrowser!.newContext({
      viewport: { width: 1100, height: 860 },
      serviceWorkers: "block",
      reducedMotion: "no-preference",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
    try {
      const sessions = [0, 1].map((index) =>
        createControlUiSessionRow(`agent:main:tooltip-${index}`, `Tooltip ${index}`, index),
      );
      await installMockGateway(page, { sessions, sessionKey: sessions[0]!.key });
      await page.goto(suite.server.baseUrl);
      const views = page.locator(".sidebar-rail openclaw-tooltip > .sidebar-rail__button");
      const pin = page.locator(".sidebar-rail__pin[title]").first();
      await pin.waitFor();
      const pinTitle = (await pin.getAttribute("title"))!;
      // Playwright locators pierce the open shadow roots that host tooltip surfaces.
      const tooltipOpen = (text: string, timeout?: number) =>
        page
          .locator(".tooltip-surface[data-phase='open']", {
            has: page.getByText(text, { exact: true }),
          })
          .waitFor({ timeout });
      const hoverCenter = async (target: typeof pin) => {
        const box = (await target.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      };
      // The second view's tooltip opens as the first one's closes. Moving on to the pin then
      // closes that shadow-hosted tooltip, which leaves the top layer after its exit animation.
      await hoverCenter(views.nth(0));
      await tooltipOpen((await views.nth(0).getAttribute("aria-label"))!);
      await hoverCenter(views.nth(1));
      await tooltipOpen((await views.nth(1).getAttribute("aria-label"))!);
      // The freeze needs the pointer to rest there first: rests under about 0.7 s did not
      // reproduce it in WebKit.
      await page.waitForTimeout(1_500);
      await hoverCenter(pin);

      const responsive = await Promise.race([
        tooltipOpen(pinTitle, 20_000).then(() => "open" as const),
        new Promise<"hung">((resolve) => {
          setTimeout(() => resolve("hung"), 15_000);
        }),
      ]);
      expect(responsive, "WebKit stopped answering after the tooltip swap").not.toBe("hung");
    } finally {
      await context.close().catch(() => undefined);
    }
  }, 60_000);
});
