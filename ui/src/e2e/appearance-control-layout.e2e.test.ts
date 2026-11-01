import { expect, it } from "vitest";
import {
  createControlUiMockBootstrapConfig,
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { polledAttribute, polledStyle, polledText } from "./chat-presentation.test-support.ts";
import { computedStyles, configSnapshot } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expectStyles } from "./style-contract.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Appearance control layout",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("keeps accent and theme controls accessible across responsive layouts", async () => {
    await suite.withPage(
      { colorScheme: "dark", locale: "en-US", viewport: { height: 1000, width: 1440 } },
      async ({ page }) => {
        const config = { ui: { prefs: { accent: "#c3cfdb", theme: "claw" } } };
        await installMockGateway(page, {
          methodResponses: {
            "config.get": configSnapshot(config, "appearance-layout", true),
          },
        });
        await page.route("**/control-ui-config.json", (route) =>
          route.fulfill({
            json: { ...createControlUiMockBootstrapConfig(), seamColor: "#123456" },
          }),
        );
        await page.goto(`${suite.server.baseUrl}settings/appearance`);
        await waitForControlUiSettingsTakeover(page);

        const headingNodes = page
          .locator(".settings-page > .settings-section > .settings-section__header")
          .locator(":scope > .settings-section__heading");
        const headings = (await headingNodes.allTextContents()).map((heading) => heading.trim());
        const themeIndex = headings.indexOf("Theme");
        expect(headings.slice(themeIndex, themeIndex + 3)).toEqual([
          "Theme",
          "Accent color",
          "Typography",
        ]);

        const accent = page.locator("#settings-appearance-accent");
        const customPicker = accent.locator("[data-accent-custom]");
        const customSwatch = accent.locator(".settings-accent-swatch--custom");
        await polledAttribute(customPicker, "aria-describedby").toBe("settings-accent-status");
        await polledText(accent.locator("#settings-accent-status")).toContain("Using Custom color");
        await accent.locator('[data-accent-preset="slate"]').focus();
        await page.keyboard.press("Tab");
        await expect
          .poll(() => customPicker.evaluate((element) => element.matches(":focus-visible")))
          .toBe(true);
        await expect
          .poll(() => computedStyles(customSwatch, ["outline-offset", "outline-width"]))
          .toEqual({ "outline-offset": "4px", "outline-width": "2px" });
        await expectStyles(customSwatch, { "box-shadow": expect.not.stringMatching(/^none$/) });

        const grid = page.locator("#settings-appearance-theme .settings-theme-grid");
        const readLayout = () =>
          grid.evaluate((element) => {
            const cards = Array.from(element.children, (card) =>
              (card as HTMLElement).getBoundingClientRect(),
            );
            return {
              columns: new Set(cards.map((card) => Math.round(card.left))).size,
              minWidth: Math.min(...cards.map((card) => card.width)),
            };
          });
        for (const [width, expectedColumns] of [
          [560, 3],
          [320, 1],
        ] as const) {
          await page.setViewportSize({ height: 1000, width });
          // Resize schedules shell rendering and a grid-track transition; observe the rendered result.
          await expect.poll(async () => (await readLayout()).columns).toBe(expectedColumns);
          const layout = await readLayout();
          expect(layout.columns).toBe(expectedColumns);
          expect(layout.minWidth).toBeGreaterThanOrEqual(150);
        }

        const colorMode = page.locator(".settings-row").filter({
          has: page.locator(".settings-row__title", { hasText: "Color mode" }),
        });
        for (const [width, direction] of [
          [768, "column"],
          [769, "row"],
        ] as const) {
          await page.setViewportSize({ height: 1000, width });
          await polledStyle(colorMode, "flexDirection").toBe(direction);
        }
      },
    );
  });
});
