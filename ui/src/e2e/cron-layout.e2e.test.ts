import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createCronLayoutMethodResponses } from "./cron-layout.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Automations layout mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const proofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const responsiveViewports = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
] as const;

suite.define(() => {
  it("keeps Automations toolbar, run actions, and history title visible across widths", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 844, width: 390 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: createCronLayoutMethodResponses(),
    });

    try {
      await page.goto(`${suite.server.baseUrl}automations`);
      await waitForControlUiRoute(page, { pathname: "/automations", routeId: "cron" });
      for (const viewport of responsiveViewports) {
        await page.setViewportSize(viewport);

        await expect
          .poll(() =>
            page.evaluate(() => {
              const primary = document.querySelector<HTMLElement>(".cron-toolbar__primary");
              const filters = document.querySelector<HTMLElement>(".cron-toolbar__filters");
              const actions = document.querySelector<HTMLElement>(".cron-toolbar__actions");
              const table = document.querySelector<HTMLElement>(".cron-table");
              const tabGroup = document.querySelector<HTMLElement>(".cron-list-hub-tabs");
              if (!primary || !filters || !actions || !table || !tabGroup) {
                return null;
              }
              const filtersBox = filters.getBoundingClientRect();
              const actionsBox = actions.getBoundingClientRect();
              const tableBox = table.getBoundingClientRect();
              const tabBox = tabGroup.getBoundingClientRect();
              return {
                actionsAboveTable: actionsBox.bottom <= tableBox.top,
                actionsRightAligned: Math.abs(tableBox.right - actionsBox.right) <= 1,
                actionsAfterTabs:
                  actionsBox.left >= tabBox.right || actionsBox.top >= tabBox.bottom,
                desktopActionsInlineWithTabs:
                  innerWidth < 1024 ||
                  Math.abs(
                    actionsBox.top + actionsBox.height / 2 - (tabBox.top + tabBox.height / 2),
                  ) <= 1,
                filtersInlineWithActions:
                  Math.abs(
                    filtersBox.top +
                      filtersBox.height / 2 -
                      (actionsBox.top + actionsBox.height / 2),
                  ) <= 1,
                actionsContainFilters: actions.contains(filters),
                primaryContainsActions: primary.contains(actions),
              };
            }),
          )
          .toEqual({
            actionsAboveTable: true,
            actionsAfterTabs: true,
            desktopActionsInlineWithTabs: true,
            actionsRightAligned: true,
            filtersInlineWithActions: true,
            actionsContainFilters: true,
            primaryContainsActions: true,
          });

        expect(
          (await page.locator(".cron-list-hub-tabs .hub-tab").allTextContents()).map((label) =>
            label.trim(),
          ),
        ).toEqual(["All", "Active", "Paused"]);
        expect(await page.locator(".cron-toolbar__filters").getByRole("radiogroup").count()).toBe(
          0,
        );
        expect(await page.locator(".cron-stats").count()).toBe(0);
        expect(await page.locator(".agent-scope-control__label").count()).toBe(0);
        expect(await page.locator(".cron-table__name-text").allTextContents()).toEqual([
          "Failing automation",
          "Healthy automation",
        ]);
        expect(await page.getByRole("button", { name: "Run history", exact: true }).count()).toBe(
          1,
        );
        expect(await page.locator(".cron-header .agent-select__trigger").isVisible()).toBe(true);
        await page.mouse.move(0, 0);
        expect(
          await page.locator(".cron-row-run").evaluateAll((buttons) =>
            buttons.map((button) => {
              const style = getComputedStyle(button);
              const box = button.getBoundingClientRect();
              return (
                style.opacity === "1" &&
                style.visibility === "visible" &&
                box.width > 0 &&
                box.height > 0
              );
            }),
          ),
        ).toEqual([true, true]);

        if (proofEnabled) {
          const proofDir = path.join(suite.artifactDir, "settings-layout-audit");
          await mkdir(proofDir, { recursive: true });
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(proofDir, `automations-toolbar-${viewport.width}.png`),
          });
        }
        await page.locator(".agent-select__trigger").click();
        const pickerTitle = page.locator(".agent-select__menu .oc-menu-heading__label");
        await pickerTitle.waitFor();
        expect(await pickerTitle.textContent()).toBe("Agent");
        expect(
          await page
            .locator(".agent-select__menu")
            .evaluate((menu) => getComputedStyle(menu).opacity),
        ).toBe("1");
        if (proofEnabled) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(
              suite.artifactDir,
              "settings-layout-audit",
              `automations-agent-picker-${viewport.width}.png`,
            ),
          });
        }
        await page.keyboard.press("Escape");
        await pickerTitle.waitFor({ state: "hidden" });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "Run history", exact: true }).click();
      const historyTitle = page.getByRole("heading", { name: "Run history", exact: true });
      await expect
        .poll(() =>
          historyTitle.evaluate((title) => {
            const box = title.getBoundingClientRect();
            return {
              visibleWidth: box.width > 1,
              visibleHeight: box.height > 1,
              clipPath: getComputedStyle(title).clipPath,
            };
          }),
        )
        .toEqual({ visibleWidth: true, visibleHeight: true, clipPath: "none" });
    } finally {
      await context.close();
    }
  });
});
