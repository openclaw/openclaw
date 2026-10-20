import { expect, it } from "vitest";
import { createEmptyCostUsageTotals } from "../../../src/infra/session-cost-usage-totals.js";
import { buildAggregatesFromSessions } from "../pages/usage/view.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installUsageOverviewGateway as installMockGateway } from "./usage-overview-fixture.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI usage session filter Unicode",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const usageTotals = {
  ...createEmptyCostUsageTotals(),
  input: 100,
  output: 20,
  totalTokens: 120,
  totalCost: 0.01,
  inputCost: 0.008,
  outputCost: 0.002,
};

function currentDay(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function usageResponse(sessionKey?: string) {
  const day = currentDay();
  return {
    updatedAt: Date.now(),
    startDate: day,
    endDate: day,
    totals: usageTotals,
    sessions: sessionKey ? [{ key: sessionKey, usage: usageTotals }] : [],
    aggregates: { ...buildAggregatesFromSessions([]), costDaily: [{ date: day, ...usageTotals }] },
  };
}

suite.define(() => {
  it.each([
    {
      name: "surrogate pair at the truncation boundary",
      key: "1234567🦞suffix",
      truncated: "1234567…",
    },
    {
      name: "surrogate pair within the truncation boundary",
      key: "123456🦞suffix",
      truncated: "123456🦞…",
    },
    {
      name: "ordinary ASCII session key",
      key: "123456789suffix",
      truncated: "12345678…",
    },
  ])("preserves $name after a selected Gateway session disappears", async (scenario) => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "sessions.usage": usageResponse(scenario.key),
            "sessions.usage.timeseries": { points: [] },
            "sessions.usage.logs": { logs: [] },
            "usage.status": { updatedAt: Date.now(), providers: [] },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}usage`);
        expect(response?.status()).toBe(200);
        await expect
          .poll(() => gateway.getRequests("sessions.usage"), { timeout: 10_000 })
          .not.toHaveLength(0);

        const row = page.locator(".session-bar-row").filter({ hasText: scenario.key });
        await expect.poll(() => row.count(), { timeout: 10_000 }).toBe(1);
        const select = row.getByRole("button", { name: scenario.key, exact: true });
        expect(await select.getAttribute("aria-pressed")).toBe("false");
        await select.focus();
        await page.keyboard.press("Shift+Enter");
        await expect.poll(() => select.getAttribute("aria-pressed")).toBe("true");

        const chip = page
          .locator(".filter-chip")
          .filter({ has: page.locator(".filter-chip-label") });
        const label = chip.locator(".filter-chip-label");
        await expect.poll(() => label.textContent(), { timeout: 10_000 }).toContain(scenario.key);
        await expect.poll(() => chip.getAttribute("title")).toBe(scenario.key);

        const overviewScope = { projection: "overview" };
        const previousRequests = (await gateway.getRequests("sessions.usage", overviewScope))
          .length;
        await gateway.setMethodResponse("sessions.usage", usageResponse());
        await page
          .locator("openclaw-usage-page .usage-header")
          .getByRole("button", { name: "Refresh", exact: true })
          .click();
        const refreshRequest = await gateway.waitForRequest("sessions.usage", {
          match: overviewScope,
          after: previousRequests,
        });
        expect(refreshRequest.params).toMatchObject({
          projection: "overview",
          selectedSessions: [scenario.key],
        });
        await expect.poll(() => row.count()).toBe(0);

        await expect.poll(() => chip.getAttribute("title")).toBe(scenario.key);
        await expect.poll(() => label.textContent()).toBe(`Session: ${scenario.truncated}`);
        const renderedLabel = (await label.textContent()) ?? "";
        expect((renderedLabel as string & { isWellFormed(): boolean }).isWellFormed()).toBe(true);
        expect(renderedLabel).not.toContain("�");
      },
    );
  });
});
