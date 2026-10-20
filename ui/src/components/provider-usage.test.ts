/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { ProviderUsageCostDaily } from "../../../src/infra/provider-usage.types.js";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { renderProviderUsageDetails } from "./solid/provider-usage.tsx";

function dailyUsage(
  date: string,
  amount: number,
  overrides: Partial<Omit<ProviderUsageCostDaily, "date" | "amount">> = {},
): ProviderUsageCostDaily {
  return {
    date,
    amount,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    ...overrides,
  };
}

function renderUsage(snapshot: Parameters<typeof renderProviderUsageDetails>[0]) {
  const container = document.createElement("div");
  mountSolid(() => renderProviderUsageDetails(snapshot), { container });
  return container;
}

describe("renderProviderUsageDetails", () => {
  it.each([
    { unit: " usd ", amount: "$12.50", zero: "$0.00" },
    { unit: "jPy", amount: "¥13", zero: "¥0" },
    { unit: " Credits ", amount: "12.5  Credits ", zero: "0  Credits " },
  ])(
    "renders provider-reported cost history and attribution for $unit",
    ({ unit, amount, zero }) => {
      const today = new Date().toISOString().slice(0, 10);
      const usage = {
        requests: 42,
        inputTokens: 1_000,
        cacheReadTokens: 400,
        outputTokens: 250,
        totalTokens: 1_250,
      };
      const container = renderUsage({
        windows: [],
        costHistory: {
          unit,
          periodDays: 30,
          daily: [
            dailyUsage(today, 12.5, usage),
            dailyUsage("2026-01-01", 0, {
              requests: 1,
              inputTokens: 50,
              outputTokens: 10,
              totalTokens: 60,
            }),
          ],
          models: [{ name: "gpt-5.5", cacheWriteTokens: 0, ...usage }],
          categories: [{ name: "Responses", amount: 12.5 }],
        },
      });

      expect(container.textContent).toContain(amount);
      expect(container.textContent).toContain("43 requests");
      expect(container.textContent).toContain("gpt-5.5");
      expect(container.textContent).toContain("Responses");
      const chart = container.querySelector('[role="group"][aria-label="Daily provider cost"]');
      expect(chart).not.toBeNull();
      const bars = chart!.querySelectorAll<HTMLElement>('[role="img"]');
      expect(bars).toHaveLength(2);
      expect(bars?.[0]?.style.height).toBe("100%");
      expect(bars?.[1]?.style.height).toBe("0%");
      expect(Array.from(bars, (bar) => [bar.title, bar.getAttribute("aria-label")])).toEqual([
        [`${today}: ${amount}`, `${today}: ${amount}`],
        [`2026-01-01: ${zero}`, `2026-01-01: ${zero}`],
      ]);
      expect(container.querySelectorAll(".provider-cost-breakdown strong")[1]?.textContent).toBe(
        amount,
      );
    },
  );

  it("preserves nonfinite chart maxima, signed amounts, and source-order cache totals", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-07T12:00:00Z"));
      const today = new Date().toISOString().slice(0, 10);
      const provider = {
        provider: "openai",
        displayName: "OpenAI",
        windows: [],
        costHistory: {
          unit: "credits",
          periodDays: 30,
          daily: [
            dailyUsage(today, 2, { cacheReadTokens: 2 ** 53 }),
            dailyUsage(today, Number.NaN, {
              cacheReadTokens: 1,
              cacheWriteTokens: -(2 ** 53),
            }),
            dailyUsage(today, -0),
          ],
          models: [],
          categories: [],
        },
      };
      const before = structuredClone(provider);
      const container = renderUsage(provider);

      expect(
        Array.from(container.querySelectorAll<HTMLElement>(".provider-cost-chart span"), (bar) => [
          bar.style.height,
          bar.title,
          bar.getAttribute("aria-label"),
        ]),
      ).toEqual([
        ["0%", `${today}: 2 credits`, `${today}: 2 credits`],
        ["0%", `${today}: NaN credits`, `${today}: NaN credits`],
        ["0%", `${today}: -0 credits`, `${today}: -0 credits`],
      ]);
      expect(
        Array.from(
          container.querySelectorAll(".provider-cost-window strong"),
          (value) => value.textContent,
        ),
      ).toEqual(["NaN credits", "NaN credits", "NaN credits"]);
      expect(container.querySelector(".provider-cost-tokens")?.textContent).toContain("0 cache");
      expect(provider).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
