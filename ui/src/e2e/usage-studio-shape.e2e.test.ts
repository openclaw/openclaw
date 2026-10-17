// Control UI E2E proves the Usage page on studio-shaped data: 30 days of local usage across
// providers, unpriced subscription traffic, interrupted turns and provider plan windows.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import studio from "./model-providers-studio-shape.fixture.json" with { type: "json" };
import { installUsageOverviewGateway } from "./usage-overview-fixture.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Usage studio-shaped data mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// The page asks for the 30 days ending today; move the captured days to end today too.
function shiftedSessionsUsage() {
  const last = new Date(`${studio.lastDate}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const offset = Math.round((today.getTime() - last.getTime()) / 86_400_000);
  const shift = (date: string) => {
    const value = new Date(`${date}T00:00:00`);
    value.setDate(value.getDate() + offset);
    return localDate(value);
  };
  const start = new Date(today);
  start.setDate(start.getDate() - 29);
  const modelDaily = studio.sessionsUsage.aggregates.modelDaily.map((row) => ({
    ...row,
    date: shift(row.date),
  }));
  // The capture kept per-model days only; the Gateway's day totals are their sums.
  const byDate = new Map<
    string,
    { date: string; totalTokens: number; totalCost: number; messages: number }
  >();
  for (const row of modelDaily) {
    const day = byDate.get(row.date) ?? {
      date: row.date,
      totalTokens: 0,
      totalCost: 0,
      messages: 0,
    };
    day.totalTokens += row.tokens;
    day.totalCost += row.cost;
    day.messages += row.count;
    byDate.set(row.date, day);
  }
  const days = [...byDate.values()];
  const assistantMessages = studio.sessionsUsage.aggregates.byProvider.reduce(
    (total, entry) => total + entry.count,
    0,
  );
  return {
    ...studio.sessionsUsage,
    updatedAt: Date.now(),
    startDate: localDate(start),
    endDate: localDate(today),
    sessions: [],
    aggregates: {
      ...studio.sessionsUsage.aggregates,
      // The capture omitted the message, tool and owner rollups; these are their empty shapes.
      messages: {
        total: assistantMessages,
        user: 0,
        assistant: assistantMessages,
        toolCalls: 0,
        toolResults: 0,
        errors: 0,
      },
      tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
      byAgent: [],
      byChannel: [],
      modelDaily,
      daily: days.map((day) => ({
        date: day.date,
        tokens: day.totalTokens,
        cost: day.totalCost,
        messages: day.messages,
        toolCalls: 0,
        errors: 0,
      })),
      costDaily: days.map((day) => ({
        date: day.date,
        input: day.totalTokens,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: day.totalTokens,
        totalCost: day.totalCost,
        inputCost: day.totalCost,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
      })),
    },
  };
}

suite.define(() => {
  it("shows lower-bound totals, per-provider days and plan windows without presenting estimates as bills", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1_280, height: 1_000 } },
      async ({ page }) => {
        // The fixture derives the overview projection from the rows, as the Gateway does.
        await installUsageOverviewGateway(page, {
          methodResponses: {
            "config.get": { config: {}, hash: "studio-shape" },
            "models.authStatus": { ...studio.authStatus, ts: Date.now() },
            "models.list": studio.modelsList,
            "usage.status": { ...studio.usageStatus, updatedAt: Date.now() },
            "sessions.usage": shiftedSessionsUsage(),
          },
        });
        // Operators reach this view from the Models page, which no longer shows local usage.
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        await page.getByRole("button", { name: "View usage", exact: true }).click();
        await waitForControlUiRoute(page, { routeId: "usage" });

        // Interrupted turns make the totals lower bounds, never exact or "$0.00".
        const badges = page.locator(".usage-metric-badge strong");
        await expect.poll(() => badges.allTextContents()).toContain("≥ $5,759.15");
        expect(
          await page.locator(".usage-lower-bound:not(.usage-lower-bound--off)").textContent(),
        ).toContain("lower bound");
        // Unpriced subscription traffic marks the cost as incomplete.
        const averageCost = page.locator(".usage-summary-card", {
          has: page.locator("#usage-summary-hint-average-cost"),
        });
        expect(await averageCost.locator('[slot="content"]').textContent()).toContain(
          "Cost data is missing",
        );

        // The daily chart stacks each day by provider; aliases fold onto their provider.
        expect(
          await page
            .getByRole("button", { name: "By Provider", exact: true })
            .getAttribute("aria-pressed"),
        ).toBe("true");
        const legend = page.locator(".daily-chart-legend li");
        // Each entry is the provider name followed by its share, e.g. "OpenAI92%".
        expect(
          (await legend.allTextContents()).map((text) => text.replace(/[\d.]+%$/, "")),
        ).toEqual(["OpenAI", "***", "xAI", "Anthropic", "Ollama Cloud"]);
        expect(await page.locator(".daily-bar-wrapper").count()).toBe(30);
        const lastDay = page.locator(".daily-bar-wrapper").last();
        expect(await lastDay.locator(".cost-segment").count()).toBeGreaterThan(1);

        // Plan windows come from the provider, beside the local estimate.
        const copilot = page.locator(".provider-usage-card", { hasText: "Copilot" });
        expect(await copilot.locator(".provider-usage-plan").textContent()).toBe("individual_pro");
        expect(
          await copilot
            .locator(".provider-usage__window", { hasText: "Premium" })
            .locator(".provider-usage__window-value")
            .textContent(),
        ).toBe("0% left");
        expect(
          await page.locator(".provider-usage-card", { hasText: "SuperGrok" }).textContent(),
        ).toContain("Prepaid balance");

        if (recordVisuals) {
          const dir = path.join(suite.artifactDir, "usage-studio-shape");
          await mkdir(dir, { recursive: true });
          for (const scheme of ["dark", "light"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page
              .locator(".usage-trend-section")
              .screenshot({ path: path.join(dir, `daily-by-provider-${scheme}.png`) });
          }
          await page.emulateMedia({ colorScheme: "dark" });
        }
      },
    );
  });
});
