import { expect, it } from "vitest";
import {
  usageMessages,
  buildAggregatesFromSessions,
  usageTotals,
} from "../pages/usage/view.test-support.ts";
import { waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installUsageOverviewGateway } from "./usage-overview-fixture.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Usage server overview",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("loads sessions by cost and preserves a quoted label when selecting a provider", async () => {
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
        await page.clock.setFixedTime(new Date("2026-08-07T12:00:00Z"));
        const sessions = ["Team Planning", "Research Review", "Team Quarterly Planning"].map(
          (label, index) => {
            const tokens = [100, 300, 200][index]!;
            return {
              key: `agent:main:quote-${index}`,
              label,
              agentId: "main",
              modelProvider: index === 1 ? "anthropic" : "openai",
              updatedAt: Date.parse("2026-08-07T12:00:00Z") - index,
              usage: {
                ...usageTotals(tokens, tokens / 100),
                firstActivity: Date.parse("2026-08-07T12:00:00Z"),
                activityDates: ["2026-08-07"],
                dailyBreakdown: [
                  {
                    ...usageTotals(tokens, tokens / 100),
                    date: "2026-08-07",
                    tokens,
                    cost: tokens / 100,
                  },
                ],
              },
            };
          },
        );
        const gateway = await installUsageOverviewGateway(page, {
          methodResponses: {
            "sessions.usage": {
              updatedAt: Date.parse("2026-08-07T12:00:00Z"),
              startDate: "2026-08-07",
              endDate: "2026-08-07",
              totals: usageTotals(600, 6),
              sessions,
              aggregates: buildAggregatesFromSessions(sessions),
            },
            "usage.status": { updatedAt: 1, providers: [] },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        await waitForControlUiRoute(page, { routeId: "model-providers" });
        await page.locator(".model-providers__search input").waitFor();
        await page.evaluate(() => window.openclawControlUi!.navigate("usage"));
        await waitForControlUiRoute(page, { routeId: "usage" });
        const query = page.locator(".usage-query-input");
        const rows = page.locator(".sessions-card .session-bar-title");
        await expect
          .poll(() => rows.allTextContents())
          .toEqual(["Research Review", "Team Quarterly Planning", "Team Planning"]);
        const initialUsageRequests = await gateway.getRequests("sessions.usage");
        expect(initialUsageRequests).toHaveLength(1);
        expect(initialUsageRequests[0]?.params).toMatchObject({
          sort: "cost",
          sortDirection: "desc",
        });
        await gateway.deferNext("sessions.usage");
        await page.locator(".sessions-sort select").selectOption("recent");
        await gateway.waitForRequest("sessions.usage", { match: { sort: "recent" } });
        await gateway.resolveDeferred("sessions.usage");
        await expect.poll(() => rows.count()).toBe(3);
        expect(pageErrors).toEqual([]);
        await query.fill('"label:Team Planning"');
        await query.press("Enter");
        await expect.poll(() => rows.allTextContents()).toEqual(["Team Planning"]);
        const previous = (await gateway.getRequests("sessions.usage")).length;
        const trigger = page.locator('[id="usage-filter-provider:trigger"]');
        await trigger.click();
        await page
          .locator('[id="usage-filter-provider:content"] [data-value="option:openai"]')
          .click();
        await gateway.waitForRequest("sessions.usage", { after: previous });
        await expect.poll(() => rows.allTextContents()).toEqual(["Team Planning"]);
        await trigger.click();
        expect(await query.inputValue()).toBe('"label:Team Planning" provider:openai ');
        expect(await page.locator(".usage-metric-badge").allTextContents()).toEqual([
          "100 Tokens",
          "$1.00 Cost",
          "1 Sessions",
        ]);
      },
    );
  });

  it("keeps all-session totals while paging and requests filters before rendering their results", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        timezoneId: "UTC",
        viewport: { width: 1440, height: 1100 },
        serviceWorkers: "block",
      },
      async ({ page }) => {
        await page.clock.setFixedTime(new Date("2026-08-07T12:00:00Z"));
        const session = (
          index: number,
          label = index === 1201 ? "Needle outside the first thousand" : `Session ${index + 1}`,
        ) => ({
          key: `agent:main:overview-${index}`,
          label,
          agentId: "main",
          sessionId: `session-${index}`,
          updatedAt: Date.parse("2026-08-07T12:00:00Z") - index,
          usage: {
            ...usageTotals(100, 0.1),
            durationMs: index === 0 ? 60000 : 0,
            messageCounts: usageMessages(),
          },
        });
        const sessions = Array.from({ length: 1250 }, (_, index) => session(index));
        const gateway = await installUsageOverviewGateway(page, {
          methodResponses: {
            "sessions.usage": {
              updatedAt: Date.parse("2026-08-07T12:00:00Z"),
              startDate: "2026-07-09",
              endDate: "2026-08-07",
              totals: usageTotals(125000, 125),
              sessions,
              aggregates: buildAggregatesFromSessions(sessions),
            },
            "usage.status": { updatedAt: 1, providers: [] },
          },
        });
        await page.goto(`${suite.server.baseUrl}usage`);
        const rows = page.locator(".sessions-card .session-bar-title");
        // The card leads with the ten costliest sessions and expands to the full server page.
        await expect.poll(() => rows.count()).toBe(10);
        await page.getByRole("button", { name: "Show all 50", exact: true }).click();
        await expect.poll(() => rows.count()).toBe(50);
        await expect
          .poll(() => page.locator(".session-bar-meta").first().textContent())
          .toContain("2 msgs");
        await expect
          .poll(() => page.locator(".session-bar-meta").first().textContent())
          .toContain("1m");
        await expect
          .poll(() => page.locator(".usage-metric-badge").allTextContents())
          .toEqual(["125.0K Tokens", "$125.00 Cost", "1,250 Sessions"]);
        expect((await gateway.getRequests("sessions.usage"))[0]?.params).toMatchObject({
          projection: "overview",
          limit: 50,
        });
        await page.getByRole("button", { name: "Next", exact: true }).click();
        await expect.poll(() => rows.first().textContent()).toBe("Session 51");
        expect((await gateway.getRequests("sessions.usage")).at(-1)?.params).toMatchObject({
          projection: "overview",
          offset: 50,
        });
        await expect
          .poll(() => page.locator(".usage-metric-badge").allTextContents())
          .toEqual(["125.0K Tokens", "$125.00 Cost", "1,250 Sessions"]);
        await page.locator(".usage-query-input").fill("label:Needle");
        await page.locator(".usage-query-input").press("Enter");
        await expect
          .poll(() => rows.allTextContents())
          .toEqual(["Needle outside the first thousand"]);
        const filtered = (await gateway.getRequests("sessions.usage")).at(-1)?.params;
        expect(filtered).toMatchObject({ projection: "overview", query: "label:Needle" });
        expect(filtered).not.toHaveProperty("offset");
        await expect
          .poll(() => page.locator(".usage-metric-badge").allTextContents())
          .toEqual(["100 Tokens", "$0.10 Cost", "1 Sessions"]);
      },
    );
  });
});
