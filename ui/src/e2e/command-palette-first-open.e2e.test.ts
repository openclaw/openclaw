import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "command palette first open" });

async function readPaletteBackdrop(page: import("playwright").Page) {
  return await page.locator("openclaw-modal-dialog.cmd-palette-overlay").evaluate((modal) => {
    const dialog = modal.shadowRoot
      ?.querySelector("wa-dialog")
      ?.shadowRoot?.querySelector("dialog");
    if (!(dialog instanceof HTMLDialogElement)) {
      throw new Error("Expected the command palette dialog");
    }
    const style = getComputedStyle(dialog, "::backdrop");
    const alphaMatch = style.backgroundColor.match(/\/\s*([\d.]+)\s*\)$/u);
    return {
      alpha: alphaMatch ? Number(alphaMatch[1]) : style.backgroundColor === "transparent" ? 0 : 1,
      filter: style.backdropFilter,
    };
  });
}

suite.define(() => {
  it("loads the palette on the shortcut without adding work to chat startup", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const sessionKey = "agent:main:dashboard:palette-on-demand";
      const foregroundDraft = "Keep the foreground draft.";
      await installMockGateway(page, { sessionKey });
      const paletteModule = await holdModuleResponse(
        page,
        /\/assets\/command-palette-[^/?]+\.js(?:\?.*)?$/u,
      );
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const composer = page.locator(".agent-chat__composer-combobox textarea:visible");
        await composer.fill(foregroundDraft);
        expect(paletteModule.requests()).toBe(0);
        expect(await page.locator(".cmd-palette").count()).toBe(0);

        await page.keyboard.press("ControlOrMeta+K");
        const input = page.locator(".cmd-palette__input:not([disabled])");
        await input.waitFor({ state: "visible" });
        await paletteModule.request;
        await input.fill("appearance");
        expect(paletteModule.requests()).toBe(1);
        paletteModule.release();
        await page.waitForFunction(() => customElements.get("openclaw-command-palette"));
        await page
          .locator("openclaw-command-palette .cmd-palette__input")
          .waitFor({ state: "visible" });
        await expect
          .poll(() => input.evaluate((element) => document.activeElement === element))
          .toBe(true);
        expect(await input.inputValue()).toBe("appearance");
        expect(await composer.inputValue()).toBe(foregroundDraft);
        expect(paletteModule.requests()).toBe(1);
      } finally {
        paletteModule.release();
      }
    });
  });

  it.each([1, 8])(
    "preserves continuous typing across release and restores the untouched foreground draft (%ix CPU)",
    async (cpuRate) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const sessionKey = "agent:main:dashboard:cold-continuous";
        await installMockGateway(page, { sessionKey });
        const paletteModule = await holdModuleResponse(
          page,
          /\/assets\/command-palette-[^/?]+\.js(?:\?.*)?$/u,
        );
        try {
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          const composer = page.locator(".agent-chat__composer-combobox textarea:visible");
          const foregroundDraft = "Foreground text must remain unchanged";
          await composer.fill(foregroundDraft);
          await composer.evaluate((element: HTMLTextAreaElement) =>
            element.setSelectionRange(3, 12, "backward"),
          );
          await page.keyboard.press("ControlOrMeta+K");
          const input = page.locator(".cmd-palette__input");
          await expect
            .poll(() => input.evaluate((element) => document.activeElement === element))
            .toBe(true);
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
          const keyTargets = await page.evaluateHandle(() => {
            const escaped: Array<{ key: string; target: string }> = [];
            const capture = (event: KeyboardEvent) => {
              const target = event.composedPath()[0];
              if (
                event.key.length === 1 &&
                !(
                  target instanceof HTMLTextAreaElement &&
                  target.classList.contains("cmd-palette__input")
                )
              ) {
                escaped.push({
                  key: event.key,
                  target: target instanceof Element ? target.tagName : "unknown",
                });
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
          expect(
            await loaded.evaluate((element: HTMLTextAreaElement) => ({
              focused: document.activeElement === element,
              start: element.selectionStart,
              end: element.selectionEnd,
            })),
          ).toEqual({ focused: true, start: typed.length, end: typed.length });
          expect(await composer.inputValue()).toBe(foregroundDraft);
          await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
          await page.keyboard.press("Escape");
          await expect
            .poll(() => composer.evaluate((element) => document.activeElement === element))
            .toBe(true);
          expect(
            await composer.evaluate((element: HTMLTextAreaElement) => ({
              start: element.selectionStart,
              end: element.selectionEnd,
              direction: element.selectionDirection,
            })),
          ).toEqual({ start: 3, end: 12, direction: "backward" });
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
        } finally {
          paletteModule.release();
        }
      });
    },
  );

  // Synthetic events verify DOM custody/ordering, not a native IME candidate window.
  it("does not replace an actively composing cold input when the module arrives", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const sessionKey = "agent:main:dashboard:cold-composition";
      await installMockGateway(page, { sessionKey });
      const paletteModule = await holdModuleResponse(
        page,
        /\/assets\/command-palette-[^/?]+\.js(?:\?.*)?$/u,
      );
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.locator(".shell").waitFor({ state: "visible" });
        await page.keyboard.press("ControlOrMeta+K");
        const input = page.locator(".cmd-palette__input");
        await expect
          .poll(() => input.evaluate((element) => document.activeElement === element))
          .toBe(true);
        const composing = await input.elementHandle();
        if (!composing) {
          throw new Error("Expected a composing input");
        }
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
        expect(
          await loaded.evaluate((element: HTMLTextAreaElement) => ({
            focused: document.activeElement === element,
            start: element.selectionStart,
            end: element.selectionEnd,
          })),
        ).toEqual({ focused: true, start: 1, end: 2 });
      } finally {
        paletteModule.release();
      }
    });
  });

  it("retires a composing cold prompt on shortcut toggle before its late module arrives", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const sessionKey = "agent:main:dashboard:cold-dismissal";
      await installMockGateway(page, { sessionKey });
      const paletteModule = await holdModuleResponse(
        page,
        /\/assets\/command-palette-[^/?]+\.js(?:\?.*)?$/u,
      );
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const composer = page.locator(".agent-chat__composer-combobox textarea:visible");
        await composer.fill("Foreground draft");
        await page.keyboard.press("ControlOrMeta+K");
        const input = page.locator(".cmd-palette__input");
        await expect
          .poll(() => input.evaluate((element) => document.activeElement === element))
          .toBe(true);
        await page.keyboard.type("Retired cold prompt");
        await input.dispatchEvent("compositionstart", { data: "に" });
        // Explicit toggle remains cancellable; composition-marked shortcut keys
        // themselves are ignored by the keyboard owner.
        await page.keyboard.press("ControlOrMeta+K");
        await expect.poll(() => page.locator(".cmd-palette").count()).toBe(0);
        await expect
          .poll(() => composer.evaluate((element) => document.activeElement === element))
          .toBe(true);
        paletteModule.release();
        await page.waitForFunction(() => customElements.get("openclaw-command-palette"));
        expect(await page.locator(".cmd-palette").count()).toBe(0);
        await page.keyboard.press("ControlOrMeta+K");
        const loaded = page.locator("openclaw-command-palette .cmd-palette__input");
        await loaded.waitFor({ state: "visible" });
        expect(await loaded.inputValue()).toBe("");
        expect(await composer.inputValue()).toBe("Foreground draft");
      } finally {
        paletteModule.release();
      }
    });
  });

  it.each([
    { height: 900, width: 1280 },
    { height: 844, width: 390 },
  ])("shows the palette shell while its module loads at $width px", async (viewport) => {
    await suite.withPage({ viewport }, async ({ page }) => {
      await installMockGateway(page);
      const paletteModule = await holdModuleResponse(
        page,
        /\/assets\/command-palette-[^/?]+\.js(?:\?.*)?$/u,
      );
      // Keep an unrelated route loader present so palette assertions cannot depend on it.
      const chatModule = await holdModuleResponse(
        page,
        /\/assets\/route-entry-[^/?]+\.js(?:\?.*)?$/u,
      );
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:dashboard:cold-shell"));
      try {
        // Navigation can finish before the shell installs its shortcut handler.
        await page.locator(".shell").waitFor({ state: "visible" });
        await page.keyboard.press("ControlOrMeta+K");

        const shell = page.locator(".cmd-palette");
        await shell.waitFor({ state: "visible" });
        await paletteModule.request;
        expect(await shell.getAttribute("aria-busy")).toBe("true");
        const input = shell.locator(".cmd-palette__input");
        expect(await input.isEditable()).toBe(true);
        await expect
          .poll(() => input.evaluate((element) => document.activeElement === element))
          .toBe(true);
        await page.keyboard.type("early query");
        await page.keyboard.press("Enter");
        expect(await input.inputValue()).toBe("early query");
        await input.evaluate((element: HTMLTextAreaElement) =>
          element.setSelectionRange(2, 7, "backward"),
        );
        const loadingBackdrop = await readPaletteBackdrop(page);
        expect(loadingBackdrop.filter).toBe("none");
        expect(loadingBackdrop.alpha).toBeLessThanOrEqual(0.2);
        await page
          .locator("openclaw-router-outlet .lazy-view-state--loading")
          .waitFor({ state: "attached" });
        expect(await shell.locator(".lazy-view-state--loading").count()).toBe(0);

        chatModule.release();
        paletteModule.release();
        const loaded = page.locator("openclaw-command-palette .cmd-palette__input");
        await loaded.waitFor({ state: "visible" });
        expect(await loaded.inputValue()).toBe("early query");
        expect(
          await loaded.evaluate((element: HTMLTextAreaElement) => ({
            focused: document.activeElement === element,
            start: element.selectionStart,
            end: element.selectionEnd,
            direction: element.selectionDirection,
          })),
        ).toEqual({ focused: true, start: 2, end: 7, direction: "backward" });
        const loadedBackdrop = await readPaletteBackdrop(page);
        expect(loadedBackdrop.filter).toBe("none");
        expect(loadedBackdrop.alpha).toBeLessThanOrEqual(0.2);
      } finally {
        paletteModule.release();
        chatModule.release();
      }
    });
  });
});
