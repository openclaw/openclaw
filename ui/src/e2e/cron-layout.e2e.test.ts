import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createCronLayoutMethodResponses } from "./cron-layout.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Automations layout mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const responsiveViewports = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
] as const;

suite.define(() => {
  it("keeps Automations toolbar, run actions, and history title visible across widths", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "light",
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

        if (viewport.width > 480) {
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
        }
        expect(
          (await page.locator(".cron-list-hub-tabs .hub-tab").allTextContents()).map((label) =>
            label.trim(),
          ),
        ).toEqual(
          viewport.width <= 480
            ? ["All", "Active", "Paused", "Activity history"]
            : ["All", "Active", "Paused"],
        );
        expect(await page.locator(".cron-toolbar__filters").getByRole("radiogroup").count()).toBe(
          0,
        );
        expect(await page.locator(".cron-stats").count()).toBe(0);
        expect(await page.locator(".agent-scope-control__label").count()).toBe(0);
        expect(await page.locator(".cron-table__name-text").allTextContents()).toEqual([
          "Failing automation",
          "Healthy automation",
        ]);
        const phone = viewport.width <= 480;
        expect(await page.getByRole("button", { name: "Run history", exact: true }).count()).toBe(
          phone ? 0 : 1,
        );
        expect(
          await page
            .locator(
              phone
                ? ".cron-toolbar__scope .agent-select__trigger"
                : ".cron-header .agent-select__trigger",
            )
            .isVisible(),
        ).toBe(true);
        expect(await page.getByRole("searchbox", { name: "Search automations" }).count()).toBe(
          phone ? 1 : 0,
        );
        expect(await page.locator(".cron-table__last").count()).toBe(phone ? 2 : 0);
        expect(await page.locator(".cron-table__footer").count()).toBe(0);
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

        await page.locator(".agent-select__trigger").click();
        const pickerTitle = page.locator(".agent-select__menu .oc-menu-heading__label");
        await pickerTitle.waitFor();
        expect(await pickerTitle.textContent()).toBe("Agent");
        expect(
          await page
            .locator(".agent-select__menu")
            .evaluate((menu) => getComputedStyle(menu).opacity),
        ).toBe("1");
        await page.keyboard.press("Escape");
        await pickerTitle.waitFor({ state: "hidden" });
        if (phone) {
          await page.getByRole("tab", { name: "Activity history", exact: true }).click();
          expect(await page.locator(".cron-run-filter-search input").isVisible()).toBe(true);
          expect(await page.getByRole("tab", { name: "All", exact: true }).count()).toBe(1);
          await page.getByRole("tab", { name: "All", exact: true }).click();
        } else {
          const history = page.getByRole("button", { name: "Run history", exact: true });
          const createBox = await page.locator(".cron-new-task").boundingBox();
          const activeFill = await page
            .locator('[role="tab"][aria-selected="true"]')
            .evaluate((tab) => getComputedStyle(tab).backgroundColor);
          await history.click();
          await page.mouse.move(0, 0);
          await page.getByRole("heading", { name: "Run history", exact: true }).waitFor();
          expect(await history.getAttribute("aria-pressed")).toBe("true");
          await expect
            .poll(() => history.evaluate((button) => getComputedStyle(button).backgroundColor))
            .toBe(activeFill);
          const historyCreateBox = await page.locator(".cron-new-task").boundingBox();
          expect(historyCreateBox?.x).toBe(createBox?.x);
          expect(historyCreateBox?.y).toBe(createBox?.y);
          expect(await page.locator(".page-subtitle").textContent()).toContain(
            "Every run of your automations.",
          );
          expect(await page.locator(".cron-toolbar:not(.cron-run-toolbar)").count()).toBe(0);
          expect(await page.getByRole("tab", { name: "All", exact: true }).count()).toBe(0);
          expect(await page.locator(".cron-new-task").isVisible()).toBe(true);
          expect(await page.locator(".cron-header .agent-select__trigger").isVisible()).toBe(true);
          await history.click();
          await page.getByRole("heading", { name: "Automations", exact: true }).waitFor();
        }
      }
    } finally {
      await context.close();
    }
  });
});
