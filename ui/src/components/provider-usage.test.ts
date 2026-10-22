/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderUsageCostDaily } from "../../../src/infra/provider-usage.types.js";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { renderProviderUsageDetails } from "./solid/provider-usage.tsx";

type Snapshot = Parameters<typeof renderProviderUsageDetails>[0];
type History = NonNullable<Snapshot["costHistory"]>;
const tokens = {
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};
function day(date: string, amount: number, overrides: Partial<ProviderUsageCostDaily> = {}) {
  return { date, amount, ...tokens, ...overrides };
}
const history = (daily: History["daily"], overrides: Partial<History> = {}): Snapshot => ({
  windows: [],
  costHistory: {
    unit: "credits",
    periodDays: 30,
    daily,
    models: [],
    categories: [],
    ...overrides,
  },
});
function renderUsage(snapshot: Snapshot) {
  const container = document.createElement("div");
  mountSolid(() => renderProviderUsageDetails(snapshot), { container });
  return container;
}
const bars = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>(".provider-cost-chart span"), (bar) => [
    bar.style.height,
    bar.title,
    bar.getAttribute("aria-label"),
  ]);
const bar = (date: string, amount: string, height: string) => [
  height,
  `${date}: ${amount}`,
  `${date}: ${amount}`,
];

afterEach(() => vi.useRealTimers());

it.each([
  { unit: " usd ", amount: "$12.50", zero: "$0.00" },
  { unit: "jPy", amount: "¥13", zero: "¥0" },
  { unit: " Credits ", amount: "12.5  Credits ", zero: "0  Credits " },
])("renders provider-reported cost history and attribution for $unit", ({ unit, amount, zero }) => {
  const today = new Date().toISOString().slice(0, 10);
  const usage = {
    requests: 42,
    cacheReadTokens: 400,
    totalTokens: 1_250,
  };
  const container = renderUsage(
    history([day(today, 12.5, usage), day("2026-01-01", 0, { requests: 1 })], {
      unit,
      models: [{ name: "gpt-5.5", ...tokens, ...usage }],
      categories: [{ name: "Responses", amount: 12.5 }],
    }),
  );
  for (const text of [amount, "43 requests", "gpt-5.5", "Responses"]) {
    expect(container.textContent).toContain(text);
  }
  const chart = container.querySelector('[role="group"][aria-label="Daily provider cost"]');
  expect(chart).not.toBeNull();
  expect(chart!.querySelectorAll('[role="img"]')).toHaveLength(2);
  expect(bars(container)).toEqual([bar(today, amount, "100%"), bar("2026-01-01", zero, "0%")]);
  expect(container.querySelectorAll(".provider-cost-breakdown strong")[1]?.textContent).toBe(
    amount,
  );
});

it("preserves nonfinite chart maxima, signed amounts, and source-order cache totals", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-07T12:00:00Z"));
  const today = new Date().toISOString().slice(0, 10);
  const provider = {
    provider: "openai",
    displayName: "OpenAI",
    ...history([
      day(today, 2, { cacheReadTokens: 2 ** 53 }),
      day(today, Number.NaN, { cacheReadTokens: 1, cacheWriteTokens: -(2 ** 53) }),
      day(today, -0),
    ]),
  };
  const before = structuredClone(provider);
  const container = renderUsage(provider);
  expect(bars(container)).toEqual([
    bar(today, "2 credits", "0%"),
    bar(today, "NaN credits", "0%"),
    bar(today, "-0 credits", "0%"),
  ]);
  const windows = container.querySelectorAll(".provider-cost-window strong");
  expect(Array.from(windows, (value) => value.textContent)).toEqual([
    "NaN credits",
    "NaN credits",
    "NaN credits",
  ]);
  expect(container.querySelector(".provider-cost-tokens")?.textContent).toContain("0 cache");
  expect(provider).toEqual(before);
});
