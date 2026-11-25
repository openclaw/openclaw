import { expect, it } from "vitest";
import type { SessionUsageEntry } from "../../../src/shared/usage-types.js";
import { buildAggregatesFromSessions, usageTotals } from "../pages/usage/view.test-support.ts";
import { waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installUsageOverviewGateway } from "./usage-overview-fixture.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Usage pending rows",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("keeps uncomputed row values unknown until usage arrives in either metric", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        timezoneId: "UTC",
        viewport: { width: 1440, height: 1100 },
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const timestamp = Date.parse("2026-08-07T12:00:00Z");
        await page.clock.setFixedTime(new Date(timestamp));
        const measured = (
          key: string,
          label: string,
          tokens: number,
          cost: number,
        ): SessionUsageEntry => ({
          key,
          label,
          agentId: "main",
          updatedAt: timestamp,
          usage: { ...usageTotals(tokens, cost), computedAt: timestamp, firstActivity: timestamp },
        });
        const sessions: SessionUsageEntry[] = [
          measured("agent:main:measured", "Measured usage", 1200, 1.2),
          measured("agent:main:zero", "Measured zero", 0, 0),
          {
            key: "agent:main:pending",
            label: "Awaiting usage",
            agentId: "main",
            updatedAt: timestamp,
            usage: null,
            computing: true,
          },
        ];
        const report = (rows: SessionUsageEntry[], complete: boolean) => ({
          updatedAt: timestamp,
          startDate: "2026-08-07",
          endDate: "2026-08-07",
          sessions: rows,
          totals: usageTotals(complete ? 1600 : 1200, complete ? 1.6 : 1.2),
          aggregates: buildAggregatesFromSessions(rows),
          cacheStatus: {
            status: complete ? "fresh" : "partial",
            cachedFiles: complete ? 3 : 2,
            pendingFiles: complete ? 0 : 1,
            staleFiles: 0,
          },
        });
        const gateway = await installUsageOverviewGateway(page, {
          methodResponses: {
            "sessions.usage": report(sessions, false),
            "usage.status": { updatedAt: 1, providers: [] },
          },
        });
        await page.goto(suite.server.baseUrl + "usage");
        await waitForControlUiRoute(page, { routeId: "usage" });
        const card = page.locator(".sessions-card");
        const row = (label: string) =>
          card
            .locator(".session-bar-row")
            .filter({ has: page.getByRole("button", { name: label, exact: true }) });
        const value = (label: string) => row(label).locator(".session-bar-value");
        await expect.poll(() => card.locator(".session-bar-row").count()).toBe(3);
        expect.soft(await value("Awaiting usage").textContent()).toBe("—");
        expect(await value("Measured zero").textContent()).toBe("0");
        expect(await value("Measured usage").textContent()).toBe("1.2K");
        await page.getByRole("button", { name: "Display", exact: true }).click();
        await page
          .getByRole("group", { name: "Metric" })
          .getByRole("button", { name: "Cost", exact: true })
          .click();
        await page.getByRole("button", { name: "Display", exact: true }).click();
        await expect.poll(() => value("Measured usage").textContent()).toBe("$1.20");
        expect.soft(await value("Awaiting usage").textContent()).toBe("—");
        expect(await value("Measured zero").textContent()).toBe("$0.00");
        const pendingRow = await row("Awaiting usage").elementHandle();
        await gateway.setMethodResponse(
          "sessions.usage",
          report(
            sessions.map((session) =>
              session.computing ? measured(session.key, session.label!, 400, 0.4) : session,
            ),
            true,
          ),
        );
        const previous = (await gateway.getRequests("sessions.usage")).length;
        await page.getByRole("button", { name: "Refresh", exact: true }).click();
        await gateway.waitForRequest("sessions.usage", { after: previous });
        await expect.poll(() => value("Awaiting usage").textContent()).toBe("$0.40");
        expect(await pendingRow!.evaluate((node) => node.isConnected)).toBe(true);
        expect(await value("Measured zero").textContent()).toBe("$0.00");
        expect(pageErrors).toEqual([]);
      },
    );
  });
});
