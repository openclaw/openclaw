// Control UI regression coverage for native and Markdown indicators in forced colors.
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeForcedColors = canRunPlaywrightChromium(chromiumExecutablePath)
  ? describe
  : describe.skip;
let browser: Browser;

function readUiCss(): string {
  return [
    "ui/src/styles/base.css",
    "ui/src/styles/components.css",
    "ui/src/styles/settings-controls.css",
    "ui/src/styles/settings.css",
    "ui/src/styles/chat/startup-layout.css",
    "ui/src/styles/chat/layout.css",
    "ui/src/styles/chat/text.css",
  ]
    .map((file) => readStyleSheet(file))
    .join("\n");
}

function fixtureDocument(direction: "ltr" | "rtl"): string {
  return [
    '<!doctype html><html dir="' +
      direction +
      '" data-theme="light" data-theme-mode="light"><head><style>' +
      readUiCss() +
      "</style><style>",
    "body { margin: 0; padding: 24px; font: 14px sans-serif; } main { max-width: 760px; margin: auto; padding: 24px; } .field, .settings-row { display: grid; gap: 6px; margin: 12px 0; } .chat-text, .chat-thinking { margin-top: 24px; }",
    "</style></head><body><main data-forced-colors-indicator-fixture>",
    "<h1>Settings and Markdown indicators</h1><p>Actual native controls and Markdown disclosure consumers.</p>",
    '<section aria-label="Native controls"><label class="field"><span>Field select</span><select><option>All sessions</option><option>Active sessions</option></select></label>',
    '<label class="field"><span>Disabled field select</span><select disabled><option>All sessions</option></select></label>',
    '<label class="settings-row"><span>Settings select</span><select class="settings-select"><option>Enter</option><option>Control + Enter</option></select></label>',
    '<label class="settings-row"><span>Disabled settings select</span><select class="settings-select" disabled><option>Enter</option></select></label></section>',
    '<section class="chat-text" aria-label="Assistant message"><details><summary>Collapsed details</summary><p>Hidden details content.</p></details>',
    '<details open><summary>Expanded details</summary><p>Visible details content.</p></details><ul><li class="task-list-item"><input class="task-list-item-checkbox" type="checkbox" checked disabled><span>Completed task</span></li></ul></section>',
    '<section class="chat-thinking" aria-label="Reasoning"><details><summary>Reasoning details</summary><p>Hidden reasoning content.</p></details></section>',
    "</main></body></html>",
  ].join("\n");
}

describeForcedColors("Control UI forced-colors indicators", () => {
  beforeAll(async () => {
    if (canRunPlaywrightChromium(chromiumExecutablePath)) {
      browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
    }
  });
  afterAll(async () => {
    await browser?.close().catch(() => {});
  });
  it("restores indicators for native selects, Markdown disclosures, and task checkboxes", async () => {
    const artifactDir = createControlUiE2eArtifactDir("forced-colors-indicators");
    for (const direction of ["ltr", "rtl"] as const) {
      const context = await browser.newContext({
        colorScheme: "light",
        forcedColors: "active",
        viewport: { width: 1100, height: 900 },
      });
      const page = await context.newPage();
      try {
        await page.setContent(fixtureDocument(direction));
        expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
        await page.locator("[data-forced-colors-indicator-fixture]").screenshot({
          animations: "disabled",
          path: path.join(artifactDir, direction + "-forced-colors.png"),
        });
        const fieldSelect = page.locator(".field select:not([disabled])");
        const settingsSelect = page.locator(".settings-select:not([disabled])");
        await fieldSelect.focus();
        expect(await fieldSelect.evaluate((element) => element.matches(":focus-visible"))).toBe(
          true,
        );
        await settingsSelect.focus();
        expect(await settingsSelect.evaluate((element) => element.matches(":focus-visible"))).toBe(
          true,
        );
        const forced = await page.evaluate(() => {
          const field = document.querySelector(".field select:not([disabled])");
          const disabledField = document.querySelector(".field select[disabled]");
          const settings = document.querySelector(".settings-select:not([disabled])");
          const disabledSettings = document.querySelector(".settings-select[disabled]");
          const collapsed = document.querySelector(".chat-text details:not([open]) > summary");
          const expanded = document.querySelector(".chat-text details[open] > summary");
          const checkbox = document.querySelector(".task-list-item-checkbox");
          const style = (element: Element | null, pseudo?: string) => {
            if (!element) {
              throw new Error("Missing indicator fixture element");
            }
            return getComputedStyle(element, pseudo);
          };
          const select = (element: Element | null) => ({
            appearance: style(element).appearance,
            backgroundImage: style(element).backgroundImage,
          });
          const disclosure = (element: Element | null) => {
            const pseudo = style(element, "::before");
            return {
              end: pseudo.borderInlineEndStyle,
              block: pseudo.borderBlockEndStyle,
              color: pseudo.borderInlineEndColor,
              transform: pseudo.transform,
            };
          };
          return {
            field: select(field),
            disabledField: select(disabledField),
            settings: select(settings),
            disabledSettings: select(disabledSettings),
            collapsed: disclosure(collapsed),
            expanded: disclosure(expanded),
            checkboxAppearance: style(checkbox).appearance,
          };
        });
        expect(forced.field.appearance).toBe("auto");
        expect(forced.disabledField.appearance).toBe("auto");
        expect(forced.settings.appearance).toBe("auto");
        expect(forced.disabledSettings.appearance).toBe("auto");
        expect(forced.collapsed.end).toBe("solid");
        expect(forced.collapsed.block).toBe("solid");
        expect(forced.expanded.end).toBe("solid");
        expect(forced.expanded.block).toBe("solid");
        const expectedTransforms =
          direction === "ltr"
            ? {
                collapsed: "matrix(0.707107, -0.707107, 0.707107, 0.707107, 0, 0)",
                expanded: "matrix(0.707107, 0.707107, -0.707107, 0.707107, 0, 0)",
              }
            : {
                collapsed: "matrix(0.707107, 0.707107, -0.707107, 0.707107, 0, 0)",
                expanded: "matrix(0.707107, -0.707107, 0.707107, 0.707107, 0, 0)",
              };
        expect(forced.collapsed.transform).toBe(expectedTransforms.collapsed);
        expect(forced.expanded.transform).toBe(expectedTransforms.expanded);
        expect(forced.checkboxAppearance).toBe("auto");
        await page.emulateMedia({ forcedColors: "none" });
        await page.locator("[data-forced-colors-indicator-fixture]").screenshot({
          animations: "disabled",
          path: path.join(artifactDir, direction + "-normal.png"),
        });
        const normal = await page.evaluate(() => {
          const field = document.querySelector(".field select:not([disabled])");
          const settings = document.querySelector(".settings-select:not([disabled])");
          const summary = document.querySelector(".chat-text details:not([open]) > summary");
          if (!field || !settings || !summary) {
            throw new Error("Missing normal-mode indicator fixture element");
          }
          return {
            field: getComputedStyle(field).appearance,
            fieldImage: getComputedStyle(field).backgroundImage,
            settings: getComputedStyle(settings).appearance,
            settingsImage: getComputedStyle(settings).backgroundImage,
            summaryImage: getComputedStyle(summary, "::before").backgroundImage,
          };
        });
        expect(normal.field).toBe("none");
        expect(normal.fieldImage).toContain("gradient");
        expect(normal.settings).toBe("none");
        expect(normal.settingsImage).toContain("gradient");
        expect(normal.summaryImage).toContain("gradient");
      } finally {
        await context.close();
      }
    }
  });
});
