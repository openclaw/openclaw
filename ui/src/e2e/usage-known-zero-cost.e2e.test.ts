import { expect, it } from "vitest";
import { createRecordedCostUsage } from "../pages/usage/test-helpers/recorded-cost.test-support.ts";
import { buildAggregatesFromSessions } from "../pages/usage/view.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installUsageOverviewGateway as installMockGateway } from "./usage-overview-fixture.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI known-zero usage cost mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

suite.define(() => {
  it("shows the recorded cost hint through ordinary Usage filters", async () => {
    const normalHint = "Average cost per message when providers report costs.";
    const missingHint = `${normalHint} Cost data is missing for some or all sessions in this range.`;
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
        const query = page.locator(".usage-query-input");
        const hintButton = page.locator("#usage-summary-hint-average-cost");
        const card = page.locator(".usage-summary-card").filter({ has: hintButton });
        const tooltipHost = hintButton.locator("xpath=..");
        const tooltip = tooltipHost.locator(".tooltip-surface[popover]");
        const hintContent = tooltipHost.locator('[slot="content"]');
        const value = card.locator(".usage-summary-value");
        const steps = [
          { stage: "mixed", query: "", count: 3, value: "$0.03" },
          { stage: "known-zero", query: 'label:"Known zero"', count: 1, value: "$0.00" },
          { stage: "cleared", query: "", count: 3, value: "$0.03" },
          { stage: "positive", query: 'label:"Known positive"', count: 1, value: "$0.10" },
          { stage: "unknown", query: 'label:"Unpriced usage"', count: 1, value: "$0.00" },
        ];
        for (const step of steps) {
          if (step.stage === "cleared") {
            await page
              .locator(".usage-query-actions")
              .getByRole("button", { name: "Clear", exact: true })
              .click();
          } else if (step.stage !== "mixed") {
            await query.fill(step.query);
            await query.press("Enter");
          }
          await expect.poll(() => page.locator(".session-bar-title").count()).toBe(step.count);
          await expect.poll(async () => (await value.textContent())?.trim()).toBe(step.value);
          await card.evaluate((element) =>
            element.scrollIntoView({ block: "center", behavior: "instant" }),
          );
          await hintButton.click();
          await expect
            .poll(() => tooltip.evaluate((element) => element.matches(":popover-open")))
            .toBe(true);
          await expect.poll(() => tooltip.isVisible()).toBe(true);
          await expect.poll(() => hintContent.isVisible()).toBe(true);
          expect((await hintContent.textContent())?.trim() ?? "", step.stage).toBe(
            ["known-zero", "positive"].includes(step.stage) ? normalHint : missingHint,
          );
          await hintButton.press("Escape");
          await expect
            .poll(() => tooltip.evaluate((element) => element.matches(":popover-open")))
            .toBe(false);
          await expect.poll(() => tooltip.isVisible()).toBe(false);
        }
        const requests = await gateway.getRequests();
        expect(requests.some(({ method }) => method === "sessions.usage")).toBe(true);
        expect(requests.some(({ method }) => method === "usage.status")).toBe(true);
      },
    );
  });
});
