import type { CDPSession } from "playwright";
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
  locale: "en-US",
  reducedMotion: "reduce",
  serviceWorkers: "block",
  viewport: { height: 900, width: 1280 },
} as const;

async function focusListenerCounts(protocol: CDPSession, selector: string) {
  const objectGroup = "picker-focus-listeners";
  try {
    const { result } = await protocol.send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      objectGroup,
    });
    const { listeners } = await protocol.send("DOMDebugger.getEventListeners", {
      objectId: expectDefined(result.objectId, "mounted picker trigger"),
    });
    return {
      blur: listeners.filter((listener) => listener.type === "blur").length,
      keydown: listeners.filter((listener) => listener.type === "keydown").length,
    };
  } finally {
    await protocol.send("Runtime.releaseObjectGroup", { objectGroup });
  }
}

suite.define(() => {
  it.each(["blur", "keydown"] as const)(
    "keeps pointer-opening focus and retained trigger listeners bounded after %s",
    async (completion) => {
      await suite.withPage(reducedMotionOptions, async ({ context, page }) => {
        const gateway = await installMockGateway(page, {});
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        const selector =
          'openclaw-chat-pane[aria-hidden="false"] [data-chat-permission-select="true"]';
        const trigger = page.locator(selector);
        const composer = page.locator(
          'openclaw-chat-pane[aria-hidden="false"] .agent-chat__composer-combobox textarea',
        );
        const retainedTrigger = expectDefined(await trigger.elementHandle(), "picker trigger");
        const protocol = await context.newCDPSession(page);
        try {
          const cycle = async () => {
            await trigger.click();
            await browserExpect(trigger).toHaveAttribute("aria-expanded", "true");
            expect(
              await retainedTrigger.evaluate(
                (element, triggerSelector) => element === document.querySelector(triggerSelector),
                selector,
              ),
            ).toBe(true);
            await browserExpect(trigger).toBeFocused();
            if (completion === "blur") {
              await composer.click();
            } else {
              await trigger.press("Shift");
              // Close on the same focused trigger; blur would consume the companion listener.
              await trigger.click();
            }
            await browserExpect(trigger).toHaveAttribute("aria-expanded", "false");
          };
          // Compare the same completed phase after the first open binds the menu.
          await cycle();
          const before = await focusListenerCounts(protocol, selector);
          for (let index = 0; index < 20; index += 1) {
            await cycle();
          }
          const after = await focusListenerCounts(protocol, selector);
          await trigger.click();
          await browserExpect(trigger).toHaveAttribute("aria-expanded", "true");
          await browserExpect(trigger).toBeFocused();
          await trigger.press("Shift");
          await browserExpect(trigger).toBeFocused();
          expect(after).toEqual(before);
        } finally {
          await protocol.detach();
          await retainedTrigger.dispose();
        }
      });
    },
  );

  it("preserves permission selection, keyboard shortcuts, and reduced motion", async () => {
    await suite.withPage(reducedMotionOptions, async ({ page }) => {
      const session = {
        key: "agent:main:session-a",
        kind: "direct",
        label: "Session A",
        permissionMode: "guarded",
        updatedAt: 2,
      };
      const gateway = await installMockGateway(page, {
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
      await trigger.press("4");
      const patch = await gateway.waitForRequest("sessions.patch");
      expect(patch.params).toMatchObject({ permissionMode: "workspace" });
      await browserExpect(trigger).toHaveAttribute("aria-expanded", "false");
      await trigger.click();
      await browserExpect(trigger).toHaveAttribute("aria-expanded", "true");
      await trigger.press("q");
      await expect
        .poll(() => pane.locator(".agent-chat__composer-combobox textarea").inputValue())
        .toBe("q");
    });
  });

  it("animates inline pickers, honors reduced motion, and keeps flipped panels visible", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
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

      for (const [picker, select] of [
        ["model", "model"],
        ["effort", "thinking"],
      ]) {
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.setViewportSize({ height: 900, width: 1280 });
        await control.evaluate((element) => {
          Object.assign((element as HTMLElement).style, {
            position: "fixed",
            right: "80px",
            top: "640px",
          });
        });
        const trigger = control.locator(`[data-chat-${select}-select="true"]`);
        const popup = control.locator(`.chat-controls__${picker}-picker > [data-anchored-overlay]`);
        await trigger.click();
        await expect
          .poll(async () => {
            const panel = expectDefined(await popup.boundingBox(), "picker bounds");
            const button = expectDefined(await trigger.boundingBox(), "trigger bounds");
            return panel.y + panel.height <= button.y;
          })
          .toBe(true);

        const topMotion = await popup.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            animationName: style.animationName,
            height: Number.parseFloat(style.height),
            originY: Number.parseFloat(style.transformOrigin.split(" ")[1] ?? ""),
          };
        });
        expect(topMotion).toMatchObject({
          animationName: "chat-composer-picker-in",
          originY: expect.closeTo(topMotion.height, 0),
        });

        await page.emulateMedia({ reducedMotion: "reduce" });
        await browserExpect(popup).toHaveCSS("animation-name", "none");

        await page.setViewportSize({ height: 320, width: 1280 });
        await control.evaluate((element) => {
          (element as HTMLElement).style.top = "24px";
        });
        await expect
          .poll(async () => {
            const panel = expectDefined(await popup.boundingBox(), "flipped picker bounds");
            const button = expectDefined(await trigger.boundingBox(), "trigger bounds");
            return panel.y >= button.y + button.height && panel.y + panel.height <= 320;
          })
          .toBe(true);
        await trigger.click();
      }
    });
  });
});
