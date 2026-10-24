import type { Locator, Page } from "playwright";
import { assert, expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "command palette first open" });
const sessionKey = "agent:main:dashboard:cold";

type HeldModule = Awaited<ReturnType<typeof holdModuleResponse>>;
type ColdCase = (
  page: Page,
  palette: HeldModule,
  chat: HeldModule | undefined,
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
) => Promise<void>;
function withColdPalette(run: ColdCase, holdChat = false) {
  const viewport = holdChat ? { height: 844, width: 390 } : { width: 1280, height: 900 };
  return suite.withPage({ viewport }, async ({ page }) => {
    const gateway = await installMockGateway(page, { sessionKey, awaitInitialRoster: !holdChat });
    const hold = (source: string) =>
      holdModuleResponse(page, controlUiE2eBuiltModuleRequest(source));
    const paletteModule = await hold("ui/src/components/command-palette.tsx");
    const chatModule = holdChat ? await hold("ui/src/pages/chat/route-entry.ts") : undefined;
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await run(page, paletteModule, chatModule, gateway);
    } finally {
      paletteModule.release();
      chatModule?.release();
    }
  });
}
const expectFocused = (input: Locator) =>
  expect.poll(() => input.evaluate((element) => document.activeElement === element)).toBe(true);
async function expectSelection(
  input: Locator,
  expected: { focused?: boolean; start: number; end: number; direction?: string },
) {
  expect(
    await input.evaluate((element: HTMLTextAreaElement) => ({
      focused: document.activeElement === element,
      start: element.selectionStart,
      end: element.selectionEnd,
      direction: element.selectionDirection,
    })),
  ).toMatchObject(expected);
}

async function expectBackdrop(page: Page) {
  const dialogLocator = page.locator(
    "openclaw-modal-dialog.cmd-palette-overlay > dialog.oc-modal-dialog",
  );
  await dialogLocator.waitFor({ state: "attached" });
  const backdrop = await dialogLocator.evaluate((dialog) => {
    const style = getComputedStyle(dialog, "::backdrop");
    const alphaMatch = style.backgroundColor.match(/\/\s*([\d.]+)\s*\)$/u);
    return {
      alpha: alphaMatch ? Number(alphaMatch[1]) : style.backgroundColor === "transparent" ? 0 : 1,
      filter: style.backdropFilter,
    };
  });
  expect(backdrop.filter).toBe("none");
  expect(backdrop.alpha).toBeLessThanOrEqual(0.2);
}

suite.define(() => {
  it("retains files accepted before the cold palette is dismissed and cancels queued submission", async () => {
    await withColdPalette(async (page, paletteModule, _chat, gateway) => {
      const composer = page.locator(".agent-chat__composer-combobox textarea:visible");
      await composer.fill("Keep foreground text");
      await page.keyboard.press("ControlOrMeta+K");
      const input = page.locator(".cmd-palette__input");
      await input.waitFor({ state: "visible" });
      await paletteModule.request;
      await input.fill("Keep the cold attachment draft");
      await input.evaluate((element) => {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(new File(["brief"], "cold-brief.pdf", { type: "application/pdf" }));
        element.dispatchEvent(
          new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }),
        );
      });
      await input.press("ControlOrMeta+Enter");
      await page.keyboard.press("ControlOrMeta+K");
      await input.waitFor({ state: "hidden" });
      await expectFocused(composer);
      paletteModule.release();
      await page.waitForFunction(() => customElements.get("openclaw-command-palette"));
      await page.keyboard.press("ControlOrMeta+K");
      const loaded = page.locator("openclaw-command-palette .cmd-palette__input");
      await loaded.waitFor({ state: "visible" });
      expect(await loaded.inputValue()).toBe("Keep the cold attachment draft");
      await expect
        .poll(() => page.locator(".chat-attachment-file__name").allTextContents())
        .toEqual(["cold-brief.pdf"]);
      expect(await loaded.isEditable()).toBe(true);
      expect(await gateway.getRequests("sessions.create")).toEqual([]);
      expect(await composer.inputValue()).toBe("Keep foreground text");
      expect(page.url()).toBe(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    });
  });

  it("preserves native text drops across the cold module handoff", async () => {
    await withColdPalette(async (page, paletteModule) => {
      const composer = page.locator(".agent-chat__composer-combobox textarea:visible");
      await composer.fill("Keep foreground text");
      await page.keyboard.press("ControlOrMeta+K");
      const input = page.locator(".cmd-palette__input:not([disabled])");
      await input.waitFor({ state: "visible" });
      await paletteModule.request;
      const bounds = await input.boundingBox();
      assert(bounds, "Cold input must have a drop target");
      const cdp = await page.context().newCDPSession(page);
      const data = {
        items: [{ mimeType: "text/plain", data: "Native dropped instructions" }],
        dragOperationsMask: 1,
      };
      for (const type of ["dragEnter", "dragOver", "drop"] as const) {
        await cdp.send("Input.dispatchDragEvent", {
          type,
          x: bounds.x + bounds.width / 2,
          y: bounds.y + bounds.height / 2,
          data,
        });
      }
      await expect.poll(() => input.inputValue()).toBe("Native dropped instructions");
      paletteModule.release();
      const loaded = page.locator("openclaw-command-palette .cmd-palette__input");
      await loaded.waitFor({ state: "visible" });
      expect(await loaded.inputValue()).toBe("Native dropped instructions");
      await expectFocused(loaded);
      await loaded.press("Escape");
      expect(await composer.inputValue()).toBe("Keep foreground text");
      expect(page.url()).toBe(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await cdp.detach();
    });
  });

  it("loads only on shortcut and preserves continuous typing and the foreground draft at 8x CPU", async () => {
    await withColdPalette(async (page, paletteModule) => {
      const composer = page.locator(".agent-chat__composer-combobox textarea:visible");
      const foregroundDraft = "Foreground draft";
      await composer.fill(foregroundDraft);
      await composer.evaluate((element: HTMLTextAreaElement) =>
        element.setSelectionRange(3, 12, "backward"),
      );
      expect(paletteModule.requests()).toBe(0);
      expect(await page.locator(".cmd-palette").count()).toBe(0);
      await page.keyboard.press("ControlOrMeta+K");
      const input = page.locator(".cmd-palette__input:not([disabled])");
      await input.waitFor({ state: "visible" });
      await paletteModule.request;
      expect(paletteModule.requests()).toBe(1);
      await expectFocused(input);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 8 });
      const keyTargets = await page.evaluateHandle(() => {
        const escaped: string[] = [];
        const capture = (event: KeyboardEvent) => {
          const target = event.composedPath()[0];
          if (target instanceof HTMLTextAreaElement && target.matches(".cmd-palette__input")) {
            return;
          }
          if (event.key.length === 1) {
            escaped.push(event.key);
          }
        };
        document.addEventListener("keydown", capture, true);
        return { escaped, stop: () => document.removeEventListener("keydown", capture, true) };
      });
      const typed =
        "Continuous cold typing must cross the module boundary without a missing character.";
      const typing = page.keyboard.type(typed, { delay: 4 });
      await expect.poll(() => input.inputValue()).not.toBe("");
      paletteModule.release();
      await typing;
      const loaded = page.locator("openclaw-command-palette .cmd-palette__input");
      await loaded.waitFor({ state: "visible" });
      expect(
        await keyTargets.evaluate(({ escaped, stop }) => {
          stop();
          return escaped;
        }),
      ).toEqual([]);
      await keyTargets.dispose();
      expect(await loaded.inputValue()).toBe(typed);
      await expectSelection(loaded, { focused: true, start: typed.length, end: typed.length });
      expect(await composer.inputValue()).toBe(foregroundDraft);
      expect(paletteModule.requests()).toBe(1);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      await page.keyboard.press("Escape");
      await expectFocused(composer);
      await expectSelection(composer, { start: 3, end: 12, direction: "backward" });
      expect(await composer.inputValue()).toBe(foregroundDraft);
      expect(page.url()).toBe(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      expect(
        await page.evaluate(() =>
          [localStorage, sessionStorage].some((storage) =>
            Object.values(storage).some(
              (value) => typeof value === "string" && value.includes("Continuous cold typing"),
            ),
          ),
        ),
      ).toBe(false);
    });
  });

  // Synthetic events verify DOM custody/ordering, not a native IME candidate window.
  it.each(["commit", "dismiss"] as const)(
    "preserves cold composition ownership through %s",
    async (outcome) => {
      await withColdPalette(async (page, paletteModule) => {
        await page.locator(".shell").waitFor({ state: "visible" });
        const composer = page.locator(".agent-chat__composer-combobox textarea:visible");
        if (outcome === "dismiss") {
          await composer.fill("Foreground draft");
        }
        await page.keyboard.press("ControlOrMeta+K");
        const input = page.locator(".cmd-palette__input");
        await expectFocused(input);
        if (outcome === "dismiss") {
          await page.keyboard.type("Retired cold prompt");
          await input.dispatchEvent("compositionstart", { data: "に" });
          await page.keyboard.press("ControlOrMeta+K");
          await expect.poll(() => page.locator(".cmd-palette").count()).toBe(0);
          await expectFocused(composer);
          paletteModule.release();
          await page.waitForFunction(() => customElements.get("openclaw-command-palette"));
          expect(await page.locator(".cmd-palette").count()).toBe(0);
          await page.keyboard.press("ControlOrMeta+K");
          const loaded = page.locator("openclaw-command-palette .cmd-palette__input");
          await loaded.waitFor({ state: "visible" });
          expect(await loaded.inputValue()).toBe("");
          expect(await composer.inputValue()).toBe("Foreground draft");
          return;
        }
        const composing = await input.evaluateHandle((element: HTMLTextAreaElement) => element);
        await composing.evaluate((element: HTMLTextAreaElement) => {
          element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
          element.value = "に";
          element.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
        });
        paletteModule.release();
        await page.waitForFunction(() => customElements.get("openclaw-command-palette"));
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        expect(
          await composing.evaluate(
            (element) => element.isConnected && document.activeElement === element,
          ),
        ).toBe(true);
        expect(await page.locator(".cmd-palette[aria-busy=true]").count()).toBe(1);
        await composing.evaluate((element: HTMLTextAreaElement) => {
          element.dispatchEvent(
            new CompositionEvent("compositionend", { bubbles: true, data: "日本" }),
          );
          element.value = "日本";
          element.dispatchEvent(new InputEvent("input", { bubbles: true, data: "日本" }));
          element.setSelectionRange(1, 2, "backward");
        });
        const loaded = page.locator("openclaw-command-palette .cmd-palette__input");
        await loaded.waitFor({ state: "visible" });
        expect(await loaded.inputValue()).toBe("日本");
        await expectSelection(loaded, { focused: true, start: 1, end: 2 });
      });
    },
  );

  it("shows the mobile palette shell while its module loads", async () => {
    await withColdPalette(async (page, paletteModule, chatModule) => {
      assert(chatModule, "Expected a held chat route");
      // Navigation can finish before the shell installs its shortcut handler.
      await page.locator(".shell").waitFor({ state: "visible" });
      await page.keyboard.press("ControlOrMeta+K");

      const shell = page.locator(".cmd-palette");
      await shell.waitFor({ state: "visible" });
      await paletteModule.request;
      expect(await shell.getAttribute("aria-busy")).toBe("true");
      const input = shell.locator(".cmd-palette__input");
      expect(await input.isEditable()).toBe(true);
      await expectFocused(input);
      await page.keyboard.type("early query");
      await page.keyboard.press("Enter");
      expect(await input.inputValue()).toBe("early query");
      await input.evaluate((element: HTMLTextAreaElement) =>
        element.setSelectionRange(2, 7, "backward"),
      );
      await expectBackdrop(page);
      await page
        .locator("openclaw-router-outlet .lazy-view-state--loading")
        .waitFor({ state: "attached" });
      expect(await shell.locator(".lazy-view-state--loading").count()).toBe(0);

      chatModule.release();
      paletteModule.release();
      const loaded = page.locator("openclaw-command-palette .cmd-palette__input");
      await loaded.waitFor({ state: "visible" });
      expect(await loaded.inputValue()).toBe("early query");
      await expectSelection(loaded, { focused: true, start: 2, end: 7, direction: "backward" });
      await expectBackdrop(page);
    }, true);
  });
});
