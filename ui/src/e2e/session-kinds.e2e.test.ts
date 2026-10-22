import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI session kinds" });
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

suite.define(() => {
  it.each([1440, 390])("keeps the sessions header and actions usable at %i px", async (width) => {
    await suite.withPage(
      { viewport: { width, height: 900 }, colorScheme: "dark" },
      async ({ page }) => {
        await installMockGateway(page, {
          sessions: [{ key: "agent:main:alpha", kind: "direct", label: "Alpha", updatedAt: 6 }],
        });
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
        await search.waitFor({ state: "visible" });
        await refresh.waitFor({ state: "visible" });
        await filter.waitFor({ state: "visible" });
        await create.waitFor({ state: "visible" });
        expect(await create.getAttribute("href")).toContain("/new");
        const positions = await Promise.all(
          [search, refresh, filter, create].map((control) =>
            control.evaluate((element) => element.getBoundingClientRect().left),
          ),
        );
        expect(positions[0]).toBeLessThan(positions[1]!);
        expect(positions[1]).toBeLessThan(positions[2]!);
        expect(positions[2]).toBeLessThan(positions[3]!);
        const styles = await Promise.all(
          [search, refresh, filter, create].map((control) =>
            control.evaluate((element) => {
              const style = getComputedStyle(element);
              return {
                width: element.getBoundingClientRect().width,
                height: element.getBoundingClientRect().height,
                background: style.backgroundColor,
                tooltip: Boolean(element.closest("openclaw-tooltip")),
              };
            }),
          ),
        );
        expect(styles.map(({ width: controlWidth, height }) => [controlWidth, height])).toEqual(
          Array.from({ length: 4 }, () => [34, 34]),
        );
        expect(
          styles.slice(0, 3).every(({ background }) => background === "rgba(0, 0, 0, 0)"),
        ).toBe(true);
        expect(styles[3]?.background).not.toBe("rgba(0, 0, 0, 0)");
        expect(styles.every(({ tooltip }) => !tooltip)).toBe(true);
        expect(await page.locator(".settings-section__heading .settings-count").count()).toBe(0);
        expect(await page.locator(".sessions-filter-bar").count()).toBe(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
        if (captureUiProof) {
          await writeFile(
            path.join(suite.artifactDir, `sessions-${width}-collapsed.png`),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [header, actions]),
          );
        }
        await search.click();
        const transcriptInput = page.getByRole("searchbox", { name: "Search session transcripts" });
        await transcriptInput.waitFor();
        if (captureUiProof) {
          await writeFile(
            path.join(suite.artifactDir, `sessions-${width}-search.png`),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [header, actions]),
          );
        }
        await transcriptInput.press("Escape");
        await filter.click();
        const popover = page.locator(".sessions-filter-popover:popover-open");
        await popover.waitFor();
        await popover
          .getByRole("textbox", { name: "Filter by key, agent, label, kind…" })
          .waitFor();
        await popover.getByRole("radiogroup", { name: "Session state" }).waitFor();
        await expect.poll(() => popover.getAttribute("data-phase")).toBe("open");
        if (captureUiProof) {
          await writeFile(
            path.join(suite.artifactDir, `sessions-${width}-filters.png`),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [header, actions]),
          );
        }
        await page.keyboard.press("Escape");
        await create.click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
      },
    );
  });

  it("groups by displayed kind while keeping the scan table compact", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const sessions = [
        { key: "agent:main:alpha", kind: "direct", label: "Alpha conversation", updatedAt: 6 },
        { key: "agent:main:cron:daily", kind: "direct", label: "Daily check", updatedAt: 5 },
        { key: "agent:main:beta", kind: "direct", label: "Beta conversation", updatedAt: 4 },
        { key: "agent:main:room", kind: "group", label: "Project room", updatedAt: 3 },
        { key: "cron:weekly", kind: "direct", label: "Weekly check", updatedAt: 2 },
        {
          key: "agent:main:pinned",
          kind: "direct",
          label: "Pinned conversation",
          updatedAt: 1,
          pinned: true,
          pinnedAt: 100,
        },
      ];
      const gateway = await installMockGateway(page, {
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
      if (captureUiProof) {
        await writeFile(
          path.join(suite.artifactDir, "session-table-compact.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [table]),
        );
      }

      await page.getByRole("button", { name: "Filters", exact: true }).click();
      await page.locator(".sessions-filter-popover:popover-open").waitFor();
      await page.locator(".session-groupby__select").selectOption("kind");
      await page.keyboard.press("Escape");
      await page.locator(".sessions-filter-popover").waitFor({ state: "hidden" });
      await table.locator(".session-group-row").first().waitFor();
      const groups = await table.locator(".session-group-row__label").allTextContents();
      if (captureUiProof) {
        await writeFile(
          path.join(suite.artifactDir, "kind-groups.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [table]),
        );
        await writeFile(
          path.join(suite.artifactDir, "kind-proof.json"),
          JSON.stringify({ groups, requests: await gateway.getRequests("sessions.list") }, null, 2),
        );
      }
      expect.soft(groups).toEqual(["cron", "direct", "group"]);
      await page.getByRole("button", { name: "Filters", exact: true }).click();
      await page.locator(".sessions-filter-popover:popover-open").waitFor();
      await page.locator(".session-groupby__select").selectOption("none");
      await expect.poll(() => table.locator(".session-group-row").count()).toBe(0);
      expect(await table.locator(".session-data-row").first().textContent()).toContain(
        "Pinned conversation",
      );
      await page.keyboard.press("Escape");
      await page.locator(".sessions-filter-popover").waitFor({ state: "hidden" });
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
          .locator(".session-detail-stat")
          .filter({ has: page.locator(".session-detail-stat__label", { hasText: "Kind" }) })
          .locator(".session-detail-stat__value")
          .textContent(),
      ).toBe("cron");

      const filters = page.getByRole("button", { name: "Filters", exact: true });
      await filters.click();
      const popover = page.locator(".sessions-filter-popover");
      await page.locator(".sessions-filter-popover:popover-open").waitFor();
      const search = popover.locator(".sessions-filter-popover__search input");
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
