import { expect, it } from "vitest";
import { createRecordedCostUsage } from "../pages/usage/test-helpers/recorded-cost.test-support.ts";
import { buildAggregatesFromSessions } from "../pages/usage/view.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  applyUsageQuery,
  installUsageOverviewGateway as installMockGateway,
} from "./usage-overview-fixture.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI known-zero usage cost mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

suite.define(() => {
  it("marks the cost total only while filtered usage has no cost data", async () => {
    const missingHint = "Some usage has no cost data.";
    const updatedAt = Date.now();
    const fixture = createRecordedCostUsage(updatedAt);
    const responses = {
      "sessions.usage": {
        updatedAt,
        startDate: fixture.costDaily[0]!.date,
        endDate: fixture.costDaily.at(-1)!.date,
        sessions: fixture.sessions,
        totals: fixture.totals,
        aggregates: {
          ...buildAggregatesFromSessions([]),
          messages: { total: 6, user: 3, assistant: 3, toolCalls: 0, toolResults: 0, errors: 0 },
          costDaily: fixture.costDaily,
        },
      },
      "usage.status": { updatedAt, providers: [] },
    };
    await suite.withPage(
      {
        locale: "en-US",
        timezoneId: "UTC",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        await page.clock.setFixedTime(new Date(updatedAt));
        const gateway = await installMockGateway(page, { methodResponses: responses });
        await page.goto(`${suite.server.baseUrl}usage`);
        const badge = page.locator(".usage-metric-badge").filter({ hasText: "Cost" });
        const hintButton = badge.locator("#usage-summary-hint-cost");
        const tooltipHost = hintButton.locator("xpath=..");
        const tooltip = tooltipHost.locator(".tooltip-surface[popover]");
        const hintContent = tooltipHost.locator('[slot="content"]');
        const value = badge.locator("strong");
        const steps = [
          { stage: "mixed", query: "", count: 3, value: "$0.20", missing: true },
          {
            stage: "known-zero",
            query: 'label:"Known zero"',
            count: 1,
            value: "$0.00",
            missing: false,
          },
          { stage: "cleared", query: "", count: 3, value: "$0.20", missing: true },
          {
            stage: "positive",
            query: 'label:"Known positive"',
            count: 1,
            value: "$0.20",
            missing: false,
          },
          {
            stage: "unknown",
            query: 'label:"Unpriced usage"',
            count: 1,
            value: "$0.00",
            missing: true,
          },
        ];
        for (const step of steps) {
          if (step.stage === "cleared") {
            await page.getByRole("button", { name: "Clear all", exact: true }).click();
          } else if (step.stage !== "mixed") {
            await applyUsageQuery(page, step.query);
          }
          await expect.poll(() => page.locator(".session-bar-title").count()).toBe(step.count);
          await expect
            .poll(async () => (await value.textContent())?.trim(), step.stage)
            .toBe(step.value);
          await expect.poll(() => hintButton.count(), step.stage).toBe(step.missing ? 1 : 0);
          if (!step.missing) {
            continue;
          }
          await hintButton.click();
          await expect
            .poll(() => tooltip.evaluate((element) => element.matches(":popover-open")))
            .toBe(true);
          await expect.poll(() => hintContent.isVisible()).toBe(true);
          expect((await hintContent.textContent())?.trim()).toBe(missingHint);
          await hintButton.press("Escape");
          await expect
            .poll(() => tooltip.evaluate((element) => element.matches(":popover-open")))
            .toBe(false);
        }
        const requests = await gateway.getRequests();
        expect(requests.some(({ method }) => method === "sessions.usage")).toBe(true);
        expect(requests.some(({ method }) => method === "usage.status")).toBe(true);
      },
    );
  });
});
