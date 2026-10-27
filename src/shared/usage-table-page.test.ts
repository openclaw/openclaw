import { expect, it } from "vitest";
import { createEmptyCostUsageTotals } from "../infra/session-cost-usage-totals.js";
import { usageOverviewPage } from "./usage-table-page.js";
import type { SessionUsageEntry } from "./usage-types.js";

it("reads each supplied sort value once per sort while retaining fallback and tie order", () => {
  const row = (key: string, updatedAt: number, totalCost = 99): SessionUsageEntry => ({
    key,
    updatedAt,
    usage: { ...createEmptyCostUsageTotals(), totalCost },
  });
  const rows = [
    row("alpha", 2),
    row("zero", 5),
    row("beta", 2),
    row("fallback", 4, 5),
    row("newer", 3),
  ];
  const values = new Map<string, number | undefined>([
    ["alpha", 7],
    ["zero", 0],
    ["beta", 7],
    ["fallback", undefined],
    ["newer", 7],
  ]);
  const calls = new Map<string, number>();
  const sortValue = (entry: SessionUsageEntry) => {
    calls.set(entry.key, (calls.get(entry.key) ?? 0) + 1);
    return values.get(entry.key);
  };
  const expectedCalls = { alpha: 1, zero: 1, beta: 1, fallback: 1, newer: 1 };

  const descending = usageOverviewPage(rows, { sort: "cost" }, sortValue);
  expect(descending.map((entry) => entry.key)).toEqual([
    "newer",
    "alpha",
    "beta",
    "fallback",
    "zero",
  ]);
  expect(Object.fromEntries(calls)).toEqual(expectedCalls);

  values.set("zero", 9);
  calls.clear();
  const ascending = usageOverviewPage(rows, { sort: "cost", sortDirection: "asc" }, sortValue);
  expect(ascending.map((entry) => entry.key)).toEqual([
    "fallback",
    "beta",
    "alpha",
    "newer",
    "zero",
  ]);
  expect(Object.fromEntries(calls)).toEqual(expectedCalls);

  calls.clear();
  const recent = usageOverviewPage(
    rows,
    { recentKeys: ["zero", "fallback", "beta", "alpha", "newer"] },
    sortValue,
  );
  expect(recent.map((entry) => entry.key)).toEqual(["zero", "fallback", "beta", "alpha", "newer"]);
  expect(calls.size).toBe(0);
});
