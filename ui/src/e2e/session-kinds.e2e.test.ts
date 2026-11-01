import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { sessionRow } from "./chat-flow-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI session kinds" });

suite.define(() => {
  it.each([1440, 390])("keeps the sessions header and actions usable at %i px", async (width) => {
    await suite.withPage(
      { viewport: { width, height: 900 }, colorScheme: "dark" },
      async ({ page }) => {
        await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}sessions`);
        const header = page.locator(".sessions-hub-header");
        const title = header.getByRole("heading", { name: "Sessions", level: 1 });
        await title.waitFor({ state: "visible" });
        await expect
          .poll(() =>
            header.evaluate((element) => {
              const heading = element.querySelector(".page-title")?.getBoundingClientRect();
              const tabRow = element
                .querySelector(".hub-page-header__tabs")
                ?.getBoundingClientRect();
              return heading && tabRow
                ? {
                    visibleTitle: heading.width > 1 && heading.height > 1,
                    leftAligned: Math.abs(heading.left - tabRow.left) <= 1,
                    tabsBelowTitle: tabRow.top >= heading.bottom,
                  }
                : null;
            }),
          )
          .toEqual({ visibleTitle: true, leftAligned: true, tabsBelowTitle: true });

        const actions = page.locator(".settings-section__actions");
        const search = actions.getByRole("button", { name: "Search transcripts" });
        const refresh = actions.getByRole("button", { name: "Refresh" });
        const filter = actions.getByRole("button", { name: "Filters", exact: true });
        const create = actions.getByRole("link", { name: "New session" });
        const controls = [search, refresh, filter, create];
        for (const control of controls) {
          await control.waitFor({ state: "visible" });
        }
        expect(await create.getAttribute("href")).toContain("/new");
        const styles = await Promise.all(
          controls.map((control) =>
            control.evaluate((element) => {
              const style = getComputedStyle(element);
              return {
                left: element.getBoundingClientRect().left,
                width: element.getBoundingClientRect().width,
                height: element.getBoundingClientRect().height,
                background: style.backgroundColor,
                tooltip: Boolean(element.closest("openclaw-tooltip")),
              };
            }),
          ),
        );
        for (let index = 1; index < styles.length; index++) {
          expect(styles[index - 1]!.left).toBeLessThan(styles[index]!.left);
        }
        expect(styles).toMatchObject(
          controls.map(() => ({ width: 34, height: 34, tooltip: false })),
        );
        expect(
          styles.slice(0, 3).every(({ background }) => background === "rgba(0, 0, 0, 0)"),
        ).toBe(true);
        expect(styles[3]?.background).not.toBe("rgba(0, 0, 0, 0)");
        expect(await page.locator(".settings-section__heading .settings-count").count()).toBe(0);
        expect(await page.locator(".sessions-filter-bar").count()).toBe(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
        await search.click();
        const transcriptInput = page.getByRole("searchbox", { name: "Search session transcripts" });
        await transcriptInput.waitFor();
        await transcriptInput.press("Escape");
        await filter.click();
        const popover = page.locator(".sessions-filter-popover:popover-open");
        await popover.waitFor();
        await popover.getByRole("button", { name: "Filter by key, agent, label, kind…" }).waitFor();
        await popover.getByRole("radiogroup", { name: "Session state" }).waitFor();
        await expect.poll(() => popover.getAttribute("data-phase")).toBe("open");
        await page.keyboard.press("Escape");
        await create.click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
      },
    );
  });

  it("groups by displayed kind while keeping the scan table compact", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const sessions = [
        sessionRow("agent:main:alpha", "Alpha conversation", 6),
        sessionRow("agent:main:cron:daily", "Daily check", 5),
        sessionRow("agent:main:beta", "Beta conversation", 4),
        sessionRow("agent:main:room", "Project room", 3, { kind: "group" }),
        sessionRow("cron:weekly", "Weekly check", 2),
        sessionRow("agent:main:pinned", "Pinned conversation", 1, { pinned: true, pinnedAt: 100 }),
      ];
      await installMockGateway(page, {
        sessionKey: "unknown",
        methodResponses: {
          "sessions.list": {
            count: sessions.length,
            defaults: { contextTokens: null, model: null, modelProvider: null },
            path: "",
            sessions,
            ts: 10,
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}sessions`);
      const table = page.locator(".sessions-table");
      await expect.poll(() => table.locator(".session-data-row").count()).toBe(6);
      expect(await table.locator("thead th").allTextContents()).toEqual([
        "",
        "Session",
        "Updated",
        "Actions",
      ]);
      expect(await table.locator(".session-data-row .session-kind").count()).toBe(0);

      const filters = page.getByRole("button", { name: "Filters", exact: true });
      const popover = page.locator(".sessions-filter-popover");
      const openFilters = async () => {
        await filters.click();
        await page.locator(".sessions-filter-popover:popover-open").waitFor();
      };
      await openFilters();
      await page.locator(".session-groupby__select").selectOption("kind");
      await page.keyboard.press("Escape");
      await popover.waitFor({ state: "hidden" });
      await table.locator(".session-group-row").first().waitFor();
      const groups = await table.locator(".session-group-row__label").allTextContents();
      expect.soft(groups).toEqual(["cron", "direct", "group"]);
      await openFilters();
      await page.locator(".session-groupby__select").selectOption("none");
      await expect.poll(() => table.locator(".session-group-row").count()).toBe(0);
      expect(await table.locator(".session-data-row").first().textContent()).toContain(
        "Pinned conversation",
      );
      await page.keyboard.press("Escape");
      await popover.waitFor({ state: "hidden" });
      await table
        .locator(".session-data-row")
        .filter({ hasText: "Daily check" })
        .locator(".session-details-toggle")
        .click();
      const details = table.locator(".session-details-panel");
      await details.waitFor();
      expect(await details.locator(".session-kind").textContent()).toBe("cron");
      expect(
        await details
          .locator('.session-detail-stat:has(.session-detail-stat__label:text("Kind"))')
          .locator(".session-detail-stat__value")
          .textContent(),
      ).toBe("cron");

      await openFilters();
      const search = popover.locator(".sessions-filter-popover__search input");
      await popover.locator(".header-search__toggle").click();
      await search.fill("Pinned");
      expect(await search.inputValue()).toBe("Pinned");
      await expect
        .poll(() => popover.evaluate((element) => element.contains(document.activeElement)))
        .toBe(true);
      await filters.click();
      await popover.waitFor({ state: "hidden" });
      await expect
        .poll(() => filters.evaluate((element) => document.activeElement === element))
        .toBe(true);
      expect(await search.inputValue()).toBe("Pinned");
    });
  });
});
