import { mkdir } from "node:fs/promises";
import path from "node:path";
import type WaTooltip from "@awesome.me/webawesome/dist/components/tooltip/tooltip.js";
import { describe, expect, it } from "vitest";
import {
  type createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import { captureUiProof, createThemedChatOpener } from "./theme-typography.test-support.ts";

export function defineTypographyModuleBoundaryTests(
  suite: ReturnType<typeof createControlUiE2eSuite>,
  moduleRequest: (sourcePath: string) => RegExp,
) {
  describe("Typography module loading", () => {
    const openThemedChat = createThemedChatOpener(suite);

    it.each(["MacIntel", "Linux x86_64"])(
      "keeps shortcut letters aligned on the system UI stack on %s",
      async (platform) => {
        const { page } = await openThemedChat("phosphor", "dark");
        await page.addInitScript((value) => {
          Object.defineProperty(navigator, "platform", { get: () => value });
        }, platform);
        const popupModule = await holdModuleResponse(
          page,
          moduleRequest("node_modules/@awesome.me/webawesome/dist/components/tooltip/tooltip.js"),
        );
        try {
          await page.goto(`${suite.server.baseUrl}chat`);
          const trigger = page.locator(".sidebar-brand__search");
          await trigger.waitFor();
          expect(popupModule.requests()).toBe(0);
          await trigger.focus();
          await popupModule.request;
          expect(await trigger.getAttribute("aria-describedby")).not.toBeNull();
          await page.keyboard.press("Escape");
          popupModule.release();
          await page.waitForFunction(() => Boolean(customElements.get("wa-tooltip")));
          const popup = trigger.locator("..").locator("wa-tooltip");
          expect(
            await popup.evaluate(async (element: WaTooltip) => {
              await element.updateComplete;
              return element.open;
            }),
          ).toBe(false);
        } finally {
          popupModule.release();
        }
        const identity = page.locator(".sidebar-identity-card");
        await identity.focus();
        await page.keyboard.press("Enter");
        const menu = page.locator("wa-dropdown.sidebar-identity-menu");
        await menu.waitFor();
        const shortcut = menu
          .locator('wa-dropdown-item[value="command:settings"]')
          .locator(".session-menu__shortcut");

        const report = await shortcut.evaluate((element) => ({
          body: getComputedStyle(document.body).fontFamily,
          shortcut: getComputedStyle(element).fontFamily,
          text: element.textContent?.replace(/\s+/gu, ""),
        }));
        expect(report.body).toMatch(/^"?JetBrains Mono/u);
        expect(report.shortcut).toMatch(/^system-ui,/u);
        const applePlatform = platform === "MacIntel";
        expect(report.text).toBe(applePlatform ? "⌘⇧," : "Ctrl+Shift+,");

        await page.keyboard.press("Escape");
        await page.locator(".chat-side-panel-toggle").click();
        const panelSelector = page.locator(".side-panel-empty--selector");
        const panelShortcuts = panelSelector.locator(".side-panel-type-option__shortcut");
        await panelSelector.waitFor();
        const labels = applePlatform
          ? ["⌘⌥⇧E", "⌘⇧B", "⌘⇧S"]
          : ["Ctrl+Alt+Shift+E", "Ctrl+Shift+B", "Ctrl+Shift+S"];
        expect(
          await panelShortcuts.evaluateAll((keys) =>
            keys.map((key) => ({
              text: key.textContent?.replace(/\s+/gu, ""),
              font: getComputedStyle(key).fontFamily,
            })),
          ),
        ).toEqual(labels.map((text) => ({ text, font: expect.stringMatching(/^system-ui,/u) })));

        const inkOffsets = await panelShortcuts.evaluateAll((keys) =>
          keys.map((key) => {
            const letter = key.querySelector<HTMLElement>(".kbd__text");
            const context = document.createElement("canvas").getContext("2d");
            if (!letter || !context) {
              throw new Error("Shortcut must have a measurable letter");
            }
            const style = getComputedStyle(letter);
            context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            const ink = context.measureText(letter.textContent ?? "");
            // A zero-height inline box exposes the text baseline without replacing the glyph.
            const baseline = document.createElement("span");
            baseline.style.cssText = "display:inline-block;width:0;height:0";
            letter.append(baseline);
            const baselineY = baseline.getBoundingClientRect().y;
            baseline.remove();
            const box = key.getBoundingClientRect();
            return (
              baselineY +
              (ink.actualBoundingBoxDescent - ink.actualBoundingBoxAscent) / 2 -
              box.y -
              box.height / 2
            );
          }),
        );
        // Font hinting rounds cap ink to device pixels; do not center the whole line box instead.
        for (const offset of inkOffsets) {
          expect(Math.abs(offset)).toBeLessThan(0.75);
        }

        if (captureUiProof) {
          await mkdir(path.join(suite.artifactDir, "theme-typography"), { recursive: true });
          await panelSelector.screenshot({
            path: path.join(
              path.join(suite.artifactDir, "theme-typography"),
              "phosphor-panel-shortcuts.png",
            ),
          });
        }

        await page.keyboard.press(`${applePlatform ? "Meta" : "Control"}+Shift+S`);
        await page.locator('[data-panel-slot="companion"]:not([hidden])').waitFor();

        const genericFonts = await page.evaluate(() => {
          const fixture = document.createElement("div");
          fixture.innerHTML = `<span class="chat-controls__model-option-action"><kbd>C</kbd></span>
          <span class="session-menu__shortcut">C</span>`;
          document.body.append(fixture);
          const fonts = Array.from(
            fixture.querySelectorAll("kbd, .session-menu__shortcut"),
            (key) => getComputedStyle(key).fontFamily,
          );
          fixture.remove();
          return {
            fonts,
            mono: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim(),
          };
        });
        expect(genericFonts.fonts).toEqual([genericFonts.mono, genericFonts.mono]);
      },
    );
  });
}
