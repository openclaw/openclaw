import { expect, it } from "vitest";
import { buildProviderSeries } from "./provider-series.ts";

const day = (provider: string, tokens: number, model = "m") => ({
  date: "2026-01-01",
  provider,
  model,
  tokens,
  cost: tokens / 100,
  count: 1,
});

it("combines repeated models, distinct models and provider aliases into one daily series", () => {
  const series = buildProviderSeries([
    day("anthropic", 100),
    day("anthropic", 100),
    day("anthropic", 100, "other"),
    day("claude-cli", 100, "other"),
  ]);
  expect(series.map(({ id, tokens }) => ({ id, tokens }))).toEqual([
    { id: "anthropic", tokens: 400 },
  ]);
  expect([...series[0]!.byDate]).toEqual([["2026-01-01", { tokens: 400, cost: 4 }]]);
});

it("keeps known providers on fixed colors and folds overflow into the shared tone", () => {
  const unknown = ["fresh-a", "fresh-b", "fresh-c", "fresh-d", "fresh-e"];
  const series = buildProviderSeries([
    day("openai", 10),
    ...unknown.map((id, index) => day(id, 900 - index * 100)),
  ]);
  const colorOf = (id: string) => series.find((entry) => entry.id === id)?.color;
  // Ranked by volume, but openai keeps its slot even with the least usage.
  expect(series.map((entry) => entry.id)).toEqual([...unknown, "openai"]);
  expect(colorOf("openai")).toBe("var(--chart-series-1)");
  // Four free slots go to the largest unknown providers; the rest share the "other" tone.
  const assigned = unknown.slice(0, 4).map(colorOf);
  expect(new Set(assigned).size).toBe(4);
  expect(assigned).not.toContain("var(--chart-series-1)");
  expect(colorOf("fresh-e")).toBe("var(--oc-border-strong)");
});
