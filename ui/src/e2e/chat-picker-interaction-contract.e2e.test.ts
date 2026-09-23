import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { CDPSession } from "playwright";
import { expect, it } from "vitest";
import {
  captureUiProof,
  captureUiProofEnabled,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  expectDefined,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

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
    "keeps retained trigger listeners bounded when %s completes pointer focus",
    async (completion) => {
      await suite.withPage(
        {
          locale: "en-US",
          reducedMotion: "reduce",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1280 },
        },
        async ({ context, page }) => {
          const gateway = await installMockGateway(page, {});
          await page.goto(`${suite.server.baseUrl}chat`);
          await gateway.waitForRequest("chat.startup");
          const selector =
            'openclaw-chat-pane[aria-hidden="false"] [data-chat-permission-select="true"]';
          const trigger = page.locator(selector);
          const picker = page.locator(
            'openclaw-chat-pane[aria-hidden="false"] .chat-controls__permission-picker',
          );
          const composer = page.locator(
            'openclaw-chat-pane[aria-hidden="false"] .agent-chat__composer-combobox textarea',
          );
          const retainedTrigger = expectDefined(await trigger.elementHandle(), "picker trigger");
          const protocol = await context.newCDPSession(page);
          const marker = "data-chat-pointer-restored-focus";
          try {
            const cycle = async () => {
              await trigger.click();
              await expect.poll(() => trigger.getAttribute(marker)).toBe("");
              expect(
                await retainedTrigger.evaluate(
                  (element, triggerSelector) => element === document.querySelector(triggerSelector),
                  selector,
                ),
              ).toBe(true);
              expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(
                true,
              );
              if (completion === "blur") {
                await composer.click();
              } else {
                await trigger.press("Shift");
              }
              await expect.poll(() => trigger.getAttribute(marker)).toBeNull();
              if (completion === "keydown") {
                // Close on the same focused trigger; blur would consume the companion listener.
                await trigger.click();
              }
              await expect.poll(() => picker.getAttribute("open")).toBeNull();
            };
            // Warm Web Awesome's own bindings, then compare the same completed phase.
            await cycle();
            const before = await focusListenerCounts(protocol, selector);
            for (let index = 0; index < 20; index += 1) {
              await cycle();
            }
            const after = await focusListenerCounts(protocol, selector);
            if (captureUiProofEnabled) {
              await writeFile(
                path.join(suite.artifactDir, `${completion}-listeners.json`),
                `${JSON.stringify({ browser: suite.browser.version(), completion, cycles: 20, before, after, retainedTriggerConnected: await retainedTrigger.evaluate((element) => element.isConnected) }, null, 2)}\n`,
              );
            }
            await captureUiProof(suite, page, "picker-focus", `${completion}-completed.png`);
            await trigger.click();
            await expect.poll(() => trigger.getAttribute(marker)).toBe("");
            await captureUiProof(suite, page, "picker-focus", `${completion}-open.png`);
            await trigger.press("Shift");
            await expect.poll(() => trigger.getAttribute(marker)).toBeNull();
            expect(after).toEqual(before);
          } finally {
            await protocol.detach();
            await retainedTrigger.dispose();
          }
        },
      );
    },
  );

  it("shows the selected permission and disables dropdown motion when requested", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      reducedMotion: "reduce",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
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

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, session.key));
      const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      const picker = pane.locator(".chat-controls__permission-picker");
      await pane.locator('[data-chat-permission-select="true"]').click();
      await pane.locator('[data-chat-permission-option="default"]').waitFor({ state: "visible" });

      const [selectedBackground, unselectedBackground, showDuration, hideDuration] =
        await Promise.all([
          pane
            .locator('[data-chat-permission-option="guarded"]')
            .evaluate((element) => getComputedStyle(element).backgroundColor),
          pane
            .locator('[data-chat-permission-option="workspace"]')
            .evaluate((element) => getComputedStyle(element).backgroundColor),
          picker.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).getPropertyValue("--show-duration")),
          ),
          picker.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).getPropertyValue("--hide-duration")),
          ),
        ]);
      expect(selectedBackground).not.toBe(unselectedBackground);
      expect(showDuration).toBe(0);
      expect(hideDuration).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("animates inline pickers from their placed edge and honors reduced motion", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      models: Array.from({ length: 12 }, (_, index) => ({
        id: `model-${index + 1}`,
        name: `Model ${index + 1}`,
        provider: "openai",
      })),
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const control = page.locator(".chat-composer-model-control");

      for (const picker of [
        {
          popup: ".chat-controls__model-picker > wa-popup",
          trigger: '[data-chat-model-select="true"]',
        },
        {
          popup: ".chat-controls__effort-picker > wa-popup",
          trigger: '[data-chat-thinking-select="true"]',
        },
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
        const trigger = control.locator(picker.trigger);
        const popup = control.locator(picker.popup);
        await trigger.click();
        await expect.poll(() => popup.getAttribute("data-current-placement")).toMatch(/^top/u);

        const topMotion = await popup.evaluate((element) => {
          const surface = element.shadowRoot?.querySelector<HTMLElement>('[part~="popup"]');
          if (!surface) {
            return null;
          }
          const style = getComputedStyle(surface);
          return {
            animationName: style.animationName,
            height: surface.offsetHeight,
            originY: Number.parseFloat(style.transformOrigin.split(" ")[1] ?? ""),
          };
        });
        expect(topMotion?.animationName).toBe("chat-composer-picker-in");
        expect(topMotion?.originY).toBeCloseTo(topMotion?.height ?? -1, 0);

        await page.emulateMedia({ reducedMotion: "reduce" });
        expect(
          await popup.evaluate((element) => {
            const surface = element.shadowRoot?.querySelector<HTMLElement>('[part~="popup"]');
            return surface ? getComputedStyle(surface).animationName : null;
          }),
        ).toBe("none");

        await page.setViewportSize({ height: 320, width: 1280 });
        await control.evaluate((element) => {
          (element as HTMLElement).style.top = "24px";
        });
        await expect.poll(() => popup.getAttribute("data-current-placement")).toMatch(/^bottom/u);
        expect(
          await popup.evaluate((element) => {
            const surface = element.shadowRoot?.querySelector<HTMLElement>('[part~="popup"]');
            return surface
              ? Number.parseFloat(getComputedStyle(surface).transformOrigin.split(" ")[1] ?? "")
              : null;
          }),
        ).toBeCloseTo(0, 0);
        await trigger.click();
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
