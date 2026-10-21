// Control UI regression coverage for native and Markdown indicators in forced colors.
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
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

function readIndicators(page: Page) {
  return page.evaluate(() => {
    const style = (selector: string, pseudo?: string) => {
      const element = document.querySelector(selector);
      if (!element) {
        throw new Error(`Missing indicator fixture: ${selector}`);
      }
      return getComputedStyle(element, pseudo);
    };
    return {
      selects: [".field select:not([disabled])", ".settings-select:not([disabled])"].map(
        (selector) => {
          const css = style(selector);
          return { appearance: css.appearance, image: css.backgroundImage };
        },
      ),
      disabled: [".field select[disabled]", ".settings-select[disabled]"].map(
        (selector) => style(selector).appearance,
      ),
      disclosures: [":not([open])", "[open]"].map((state) => {
        const css = style(`.chat-text details${state} > summary`, "::before");
        return [css.borderInlineEndStyle, css.borderBlockEndStyle, css.transform];
      }),
      summaryImage: style(".chat-text details:not([open]) > summary", "::before").backgroundImage,
      checkbox: style(".task-list-item-checkbox").appearance,
    };
  });
}

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
    `<!doctype html><html dir="${direction}" data-theme="light" data-theme-mode="light"><head><style>${readUiCss()}</style><style>`,
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
    browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
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
        for (const selector of [".field select", ".settings-select"]) {
          const select = page.locator(`${selector}:not([disabled])`);
          await select.focus();
          expect(await select.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
        }
        const forced = await readIndicators(page);
        const clockwise = "matrix(0.707107, 0.707107, -0.707107, 0.707107, 0, 0)";
        const counterclockwise = "matrix(0.707107, -0.707107, 0.707107, 0.707107, 0, 0)";
        expect(forced.selects.map((select) => select.appearance)).toEqual(["auto", "auto"]);
        expect(forced.disabled).toEqual(["auto", "auto"]);
        expect(forced.checkbox).toBe("auto");
        expect(forced.disclosures).toEqual([
          ["solid", "solid", direction === "ltr" ? counterclockwise : clockwise],
          ["solid", "solid", direction === "ltr" ? clockwise : counterclockwise],
        ]);
        await page.emulateMedia({ forcedColors: "none" });
        await page.locator("[data-forced-colors-indicator-fixture]").screenshot({
          animations: "disabled",
          path: path.join(artifactDir, direction + "-normal.png"),
        });
        const normal = await readIndicators(page);
        expect(normal.selects).toEqual([
          { appearance: "none", image: expect.stringContaining("gradient") },
          { appearance: "none", image: expect.stringContaining("gradient") },
        ]);
        expect(normal.summaryImage).toContain("gradient");
      } finally {
        await context.close();
      }
    }
  });
});
