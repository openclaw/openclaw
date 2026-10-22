import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { withBrowserPage } from "../test-helpers/browser-page.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { readStyles, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("forced-colors-indicators-", { ignoreCloseErrors: true });

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

const css = readStyles(
  ...[
    "base",
    "components",
    "settings-controls",
    "settings",
    "chat/startup-layout",
    "chat/layout",
    "chat/text",
  ].map((name) => `styles/${name}`),
);

function fixtureDocument(direction: "ltr" | "rtl"): string {
  return [
    `<!doctype html><html dir="${direction}" data-theme="light" data-theme-mode="light"><head><style>${css}</style><style>`,
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

fixture.describe("Control UI forced-colors indicators", () => {
  it("restores indicators for native selects, Markdown disclosures, and task checkboxes", async () => {
    const artifactDir = createControlUiE2eArtifactDir("forced-colors-indicators");
    for (const direction of ["ltr", "rtl"] as const) {
      await withBrowserPage(
        fixture.page({
          colorScheme: "light",
          forcedColors: "active",
          viewport: { width: 1100, height: 900 },
        }),
        async (page) => {
          await page.setContent(fixtureDocument(direction));
          expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(
            true,
          );
          await page.locator("[data-forced-colors-indicator-fixture]").screenshot({
            animations: "disabled",
            path: path.join(artifactDir, direction + "-forced-colors.png"),
          });
          for (const selector of [".field select", ".settings-select"]) {
            const select = page.locator(`${selector}:not([disabled])`);
            await select.focus();
            expect(await select.evaluate((element) => element.matches(":focus-visible"))).toBe(
              true,
            );
          }
          const forced = await readIndicators(page);
          const clockwise = "matrix(0.707107, 0.707107, -0.707107, 0.707107, 0, 0)";
          const counterclockwise = "matrix(0.707107, -0.707107, 0.707107, 0.707107, 0, 0)";
          expect(forced).toMatchObject({
            selects: [{ appearance: "auto" }, { appearance: "auto" }],
            disabled: ["auto", "auto"],
            checkbox: "auto",
            disclosures: [
              ["solid", "solid", direction === "ltr" ? counterclockwise : clockwise],
              ["solid", "solid", direction === "ltr" ? clockwise : counterclockwise],
            ],
          });
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
        },
      );
    }
  });
});
