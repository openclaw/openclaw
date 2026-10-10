import path from "node:path";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Browser panel default width" });

suite.define(() => {
  it.each([1200, 1440, 2048])(
    "uses the available pane at %ipx and preserves a resized width",
    async (width) => {
      await suite.withPage({ viewport: { width, height: 1000 } }, async ({ page }) => {
        await installMockGateway(page, {
          featureMethods: ["browser.request", "chat.metadata", "chat.startup"],
          historyMessages: [
            {
              role: "assistant",
              content: "Keep the conversation readable while browsing beside it.",
            },
          ],
          methodResponses: {
            "browser.request": {
              cases: [
                { match: { method: "GET", path: "/tabs" }, response: { running: true, tabs: [] } },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForControlUiGatewayReady(page);
        const region = page.locator(".sidebar-region");
        const browser = page.locator('[data-panel-slot="browser"]');
        const composer = page.locator(".agent-chat__composer-shell");
        const transcript = page.locator(".chat-thread-inner");
        await openChatSidePanelType(page, "Browser");
        await browser.waitFor();
        const paneWidth = (await region.boundingBox())!.width;
        const browserWidth = () =>
          browser.evaluate((element) => element.getBoundingClientRect().width);
        await expect.poll(browserWidth).toBeGreaterThan(paneWidth * 0.49);
        expect(await browserWidth()).toBeLessThanOrEqual(paneWidth * 0.6);
        const [composerBounds, transcriptBounds] = await Promise.all([
          composer.boundingBox(),
          transcript.boundingBox(),
        ]);
        expect(composerBounds).not.toBeNull();
        expect(transcriptBounds).not.toBeNull();
        expect(composerBounds!.x).toBeCloseTo(transcriptBounds!.x, 0);
        expect(composerBounds!.width).toBeCloseTo(transcriptBounds!.width, 0);
        await page.screenshot({ path: path.join(suite.artifactDir, `browser-${width}.png`) });
        const divider = page.getByRole("separator", { name: "Resize side panel" });
        const defaultWidth = await browserWidth();
        await divider.focus();
        await page.keyboard.press("ArrowRight");
        await expect.poll(browserWidth).toBeLessThan(defaultWidth);
        const resizedWidth = await browserWidth();
        await page.reload();
        await browser.waitFor();
        await expect.poll(browserWidth).toBeCloseTo(resizedWidth, 0);
        await page.setViewportSize({ width: 400, height: 900 });
        await page.locator(".sidebar-region--narrow").waitFor();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(400);
        await page.setViewportSize({ width, height: 1000 });
        await expect.poll(browserWidth).toBeCloseTo(resizedWidth, 0);
      });
    },
  );
});
