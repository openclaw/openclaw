import type { Page } from "playwright";
import { expect, it } from "vitest";
import { withBrowserPage } from "../test-helpers/browser-page.ts";
import { readStyles, styleDocument, styleFixture } from "./style-fixture.test-support.ts";

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
  "styles/base",
  "styles/components",
  "styles/settings-controls",
  "styles/settings",
  "styles/channels",
  "styles/plugins",
  "styles/usage",
  "styles/chat/startup-layout",
  "styles/chat/layout",
  "styles/chat/text",
  "pages/chat/components/chat-processes-panel",
  "pages/chat/components/chat-subagents-panel-desktop",
);

function fixtureDocument(direction: "ltr" | "rtl"): string {
  return styleDocument(
    css,
    `<label class="field"><select><option>All sessions</option></select><select disabled><option>All sessions</option></select></label>
    <label class="settings-row"><select class="settings-select"><option>Enter</option></select><select class="settings-select" disabled><option>Enter</option></select></label>
    <section class="chat-text"><details><summary>Collapsed</summary></details><details open><summary>Expanded</summary></details>
    <ul><li class="task-list-item"><input class="task-list-item-checkbox" type="checkbox" checked disabled></li></ul></section>`,
    `dir="${direction}" data-theme="light" data-theme-mode="light"`,
  );
}

fixture.describe("Control UI forced-colors indicators", () => {
  it("keeps masked status rings readable against their opaque backing", async () => {
    await withBrowserPage(
      fixture.page({ forcedColors: "active", colorScheme: "light" }),
      async (page) => {
        await page.setContent(
          styleDocument(
            css,
            `
        <span id="palette" style="color:CanvasText;background:Canvas"></span>
        <span class="chat-processes__spinner"></span>
        <span class="subagents-desktop__spinner"></span>`,
            'data-theme-mode="dark"',
          ),
        );
        const colors = await page.evaluate(() => {
          const palette = getComputedStyle(document.getElementById("palette")!);
          return {
            expected: [palette.backgroundColor, palette.color],
            actual: Array.from(
              document.querySelectorAll(".chat-processes__spinner, .subagents-desktop__spinner"),
            ).map((element) => [
              getComputedStyle(element).backgroundColor,
              getComputedStyle(element, "::before").backgroundColor,
            ]),
          };
        });
        for (const actual of colors.actual) {
          expect(actual).toEqual(colors.expected);
        }
      },
    );
  });

  it("keeps row-button keyboard focus visible when forced colors suppress shadows", async () => {
    const classes = [
      "channels-item__detail",
      "plugins-item__detail-button",
      "session-bar-selection",
    ];
    await withBrowserPage(fixture.page({ forcedColors: "active" }), async (page) => {
      await page.setContent(
        `<!doctype html><html data-theme="light"><head><style>${css}</style></head><body><main style="margin:40px;padding:24px"><h1>Keyboard focus in forced colors</h1>${classes.map((name) => `<p><button type="button" class="${name}">${name}</button></p>`).join("")}</main></body></html>`,
      );
      for (const name of classes) {
        const button = page.locator(`.${name}`);
        await page.keyboard.press("Tab");
        expect(
          await button.evaluate((element) => {
            const style = getComputedStyle(element);
            return [
              element.matches(":focus-visible"),
              style.outlineStyle,
              style.outlineWidth,
              style.boxShadow,
            ];
          }),
        ).toEqual([true, "solid", "2px", "none"]);
      }
    });
  });

  it("restores indicators for native selects, Markdown disclosures, and task checkboxes", async () => {
    for (const direction of ["ltr", "rtl"] as const) {
      await withBrowserPage(
        fixture.page({ colorScheme: "light", forcedColors: "active" }),
        async (page) => {
          await page.setContent(fixtureDocument(direction));
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
          const normal = await readIndicators(page);
          const selectStyle = { appearance: "base-select", image: "none" };
          expect(normal.selects).toEqual([selectStyle, selectStyle]);
          expect(normal.summaryImage).toContain("gradient");
          // Engines without customizable selects keep the gradient chevron.
          await page.evaluate(() => {
            for (const style of document.querySelectorAll("style")) {
              style.textContent = style.textContent.replaceAll(
                "@supports (appearance: base-select)",
                "@supports (appearance: openclaw-unsupported)",
              );
            }
          });
          const fallback = await readIndicators(page);
          const fallbackStyle = { appearance: "none", image: expect.stringContaining("gradient") };
          expect(fallback.selects).toEqual([fallbackStyle, fallbackStyle]);
        },
      );
    }
  });
});
