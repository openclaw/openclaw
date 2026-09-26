import { html, render } from "lit";
import { afterEach, expect, it } from "vitest";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import { registerUsageEnglish } from "../../i18n/locales/en-usage.ts";
import "../../styles.css";
import "../../styles/usage.css";
import { renderCostBreakdownCompact, renderDailyChartCompact } from "./view-chart.ts";

registerUsageEnglish();
afterEach(() => document.body.replaceChildren());

it("keeps token segments proportional and legend markers round beside form styles", async () => {
  const { page } = await import("vitest/browser");
  await page.viewport(1100, 800);
  const totals = {
    ...createEmptyCostUsageTotals(),
    input: 10,
    output: 10,
    cacheRead: 80,
    totalTokens: 100,
  };
  const container = document.createElement("div");
  document.body.append(container);
  render(
    html`
      ${renderDailyChartCompact(
        [{ ...totals, date: "2026-09-18" }],
        [],
        "tokens",
        "by-type",
        () => {},
        () => {},
        { startDate: "2026-09-18", endDate: "2026-09-18", complete: true },
      )}
      ${renderCostBreakdownCompact(totals, "tokens")}
    `,
    container,
  );
  await Promise.all(
    [...container.querySelectorAll("openclaw-tooltip")].map((tooltip) => tooltip.updateComplete),
  );
  const segments = [
    ...container.querySelectorAll<HTMLElement>(".daily-bar--stacked .cost-segment"),
  ];
  const input = segments[1]!;
  const cacheRead = segments[3]!;
  expect(getComputedStyle(input).paddingTop).toBe("0px");
  expect(
    input.getBoundingClientRect().height / cacheRead.getBoundingClientRect().height,
  ).toBeCloseTo(10 / 80, 1);
  const legend = container.querySelectorAll<HTMLElement>(".legend-dot")[1]!;
  expect(legend.getBoundingClientRect().width).toBeCloseTo(
    legend.getBoundingClientRect().height,
    1,
  );
  expect(legend.getBoundingClientRect().width).toBeLessThanOrEqual(12);
});
