import { expect as browserExpect } from "playwright/test";
import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  expectDefined,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const reducedMotionOptions = {
  ...createControlUiE2eContextOptions(),
  reducedMotion: "reduce",
} as const;

suite.define(() => {
  it("distinguishes the selected permission and honors reduced motion", () =>
    suite.withPage(reducedMotionOptions, async ({ page }) => {
      const session = {
        key: "agent:main:session-a",
        kind: "direct",
        label: "Session A",
        permissionMode: "guarded",
        updatedAt: 2,
      };
      await installMockGateway(page, {
        methodResponses: { "sessions.list": chatSessionListResponse([session]) },
        sessionKey: session.key,
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, session.key));
      const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      const menu = pane.locator(".chat-controls__permission-menu");
      const trigger = pane.locator('[data-chat-permission-select="true"]');
      await trigger.click();
      await pane.locator('[data-chat-permission-option="default"]').waitFor({ state: "visible" });
      const backgrounds = await pane
        .locator(
          '[data-chat-permission-option="guarded"], [data-chat-permission-option="workspace"]',
        )
        .evaluateAll((options) =>
          options.map((element) => getComputedStyle(element).backgroundColor),
        );
      expect(backgrounds).toHaveLength(2);
      expect(backgrounds[0]).not.toBe(backgrounds[1]);
      await browserExpect(menu).toHaveCSS("transition-duration", "0s");
    }));

  it("animates inline pickers, honors reduced motion, and keeps flipped panels visible", () =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        models: Array.from({ length: 12 }, (_, index) => ({
          id: `model-${index + 1}`,
          name: `Model ${index + 1}`,
          provider: "openai",
        })),
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const control = page.locator(".chat-composer-model-control");
      const placeControl = (top: string) =>
        control.evaluate((element, y) => {
          Object.assign((element as HTMLElement).style, {
            position: "fixed",
            right: "80px",
            top: y,
          });
        }, top);
      for (const [picker, select] of [
        ["model", "model"],
        ["effort", "thinking"],
      ]) {
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.setViewportSize({ height: 900, width: 1280 });
        await placeControl("640px");
        const trigger = control.locator(`[data-chat-${select}-select="true"]`);
        const popup = control.locator(`.chat-controls__${picker}-picker > [data-anchored-overlay]`);
        const panelFits = async (above: boolean) => {
          const panel = expectDefined(await popup.boundingBox(), "picker bounds");
          const button = expectDefined(await trigger.boundingBox(), "trigger bounds");
          return above
            ? panel.y + panel.height <= button.y
            : panel.y >= button.y + button.height && panel.y + panel.height <= 320;
        };
        await trigger.click();
        await expect.poll(() => panelFits(true)).toBe(true);
        const topMotion = await popup.evaluate((element) => {
          const { animationName, height, transformOrigin } = getComputedStyle(element);
          return {
            animationName,
            originDelta:
              Number.parseFloat(transformOrigin.split(" ")[1] ?? "") - Number.parseFloat(height),
          };
        });
        expect(topMotion).toEqual({
          animationName: "chat-composer-picker-in",
          originDelta: expect.closeTo(0, 0),
        });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await browserExpect(popup).toHaveCSS("animation-name", "none");
        await page.setViewportSize({ height: 320, width: 1280 });
        await placeControl("24px");
        await expect.poll(() => panelFits(false)).toBe(true);
        await trigger.click();
      }
    }));
});
