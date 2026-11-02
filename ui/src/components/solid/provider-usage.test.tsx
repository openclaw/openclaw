/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { ProviderUsageCostDaily } from "../../../../src/infra/provider-usage.types.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  ProviderUsageChips,
  type ProviderUsageDetails,
  ProviderUsagePanel,
} from "./provider-usage.tsx";

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

const rowValues = (container: HTMLElement) =>
  Array.from(container.querySelectorAll(".provider-usage__row"), (row) => [
    row.querySelector(".oc-menu-panel-usage-label")?.textContent,
    row.querySelector(".oc-menu-panel-usage-value")?.textContent,
  ]);

describe("ProviderUsagePanel", () => {
  it("retains usage rows across fresh snapshots and updates their visible values", () => {
    const initial: ProviderUsageDetails = {
      windows: [
        { label: "5h", groupLabel: "Account A", usedPercent: 25 },
        { label: "5h", groupLabel: "Account A", usedPercent: 30 },
        { label: "5h", groupLabel: "Account B", usedPercent: 40 },
      ],
      billing: [
        { type: "balance", amount: 12, unit: "credits" },
        { type: "balance", amount: 8, unit: "credits" },
      ],
      costHistory: {
        unit: "USD",
        periodDays: 30,
        daily: [dailyUsage(new Date().toISOString().slice(0, 10), 2)],
        models: [],
        categories: [],
      },
    };
    const [usage, setUsage] = createSignal(initial);
    const view = mountSolid(() => (
      <>
        <ProviderUsagePanel usage={usage()} />
        <ProviderUsageChips usage={usage()} />
      </>
    ));
    const rows = () => [
      ...view.container.querySelectorAll(
        ".provider-usage__group, .provider-usage__window, .provider-usage__row, .provider-usage__chip",
      ),
    ];
    const before = rows();
    expect(before).toHaveLength(12);

    setUsage(structuredClone(initial));
    flush();
    expect(rows().filter((row) => !before.includes(row))).toHaveLength(0);

    const changed = structuredClone(initial);
    changed.windows[0]!.usedPercent = 90;
    changed.billing![0] = { type: "balance", amount: 14, unit: "credits" };
    changed.costHistory!.daily[0]!.amount = 4;
    setUsage(changed);
    flush();
    expect(rows()).toEqual(before);
    expect(view.container.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe(
      "10",
    );
    expect(view.container.querySelector(".provider-usage__window")?.getAttribute("data-tone")).toBe(
      "error",
    );
    expect(view.container.querySelector(".provider-usage__chip-value")?.textContent).toBe(
      "10% left",
    );
    expect(rowValues(view.container)).toEqual([
      ["Balance", "14 credits"],
      ["Balance", "8 credits"],
      ["Today", "$4.00"],
      ["7 days", "$4.00"],
      ["30 days", "$4.00"],
    ]);
  });

  it("groups windows in rank order and presents remaining headroom accessibly", () => {
    const view = mountSolid(() => (
      <ProviderUsagePanel
        usage={{
          windows: [
            { label: "Weekly", groupLabel: "Account A", usedPercent: 92 },
            { label: "5h", groupLabel: "Account A", usedPercent: 25 },
            { label: "Monthly", groupLabel: "Account B", usedPercent: 80 },
          ],
          summary: "Provider summary",
        }}
      />
    ));
    const meters = [...view.container.querySelectorAll<HTMLElement>('[role="meter"]')];
    expect(
      meters.map((meter) => [
        meter.getAttribute("aria-label"),
        meter.getAttribute("aria-valuenow"),
        meter.closest(".provider-usage__window")?.getAttribute("data-tone"),
      ]),
    ).toEqual([
      ["5h", "75", null],
      ["Weekly", "8", "error"],
      ["Monthly", "20", "warning"],
    ]);
    expect(meters[0]?.querySelector<HTMLElement>("span")?.style.width).toBe("75%");
    expect(
      Array.from(
        view.container.querySelectorAll(".provider-usage__note"),
        (note) => note.textContent,
      ),
    ).toEqual(["Account A", "Account B", "Provider summary"]);
  });

  it("names a used-up window and when it comes back", () => {
    const resetAt = Date.now() + 3 * 3_600_000;
    const view = mountSolid(() => (
      <ProviderUsagePanel
        usage={{
          windows: [
            { label: "Premium", usedPercent: 100, resetAt },
            { label: "Chat", usedPercent: 0 },
          ],
        }}
      />
    ));
    const alert = view.container.querySelector('.provider-usage__alert[role="status"]');
    expect(alert?.textContent).toMatch(/^Premium is used up until .+\.$/u);
    const reset = view.container.querySelector(".provider-usage__window .provider-usage__reset");
    expect(reset?.textContent).toMatch(/^Resets .+ · in 3h$/u);
    // A window with no reported reset says nothing rather than guessing.
    expect(view.container.querySelectorAll(".provider-usage__reset")).toHaveLength(1);
  });

  it.each([
    { unit: " usd ", amount: "$12.50", zero: "$0.00" },
    { unit: "jPy", amount: "¥13", zero: "¥0" },
    { unit: " Credits ", amount: "12.5  Credits ", zero: "0  Credits " },
  ])("renders provider-billed cost windows and attribution in $unit", ({ unit, amount }) => {
    const today = new Date().toISOString().slice(0, 10);
    const view = mountSolid(() => (
      <ProviderUsagePanel
        usage={{
          windows: [],
          billing: [{ type: "budget", used: 2.5, limit: 10, unit: "USD" }],
          costHistory: {
            unit,
            periodDays: 30,
            daily: [
              dailyUsage(today, 12.5, {
                requests: 42,
                inputTokens: 1_000,
                cacheReadTokens: 400,
                outputTokens: 250,
                totalTokens: 1_250,
              }),
              dailyUsage("2026-01-01", 0, { requests: 1, inputTokens: 50, outputTokens: 10 }),
            ],
            models: [
              {
                name: "gpt-5.5",
                requests: 42,
                inputTokens: 1_000,
                cacheReadTokens: 400,
                cacheWriteTokens: 0,
                outputTokens: 250,
                totalTokens: 1_250,
              },
            ],
            categories: [{ name: "Responses", amount: 12.5 }],
          },
        }}
      />
    ));
    expect(rowValues(view.container)).toEqual([
      ["Budget", "$2.50 / $10.00"],
      ["Today", amount],
      ["7 days", amount],
      ["30 days", amount],
      ["Top models", "gpt-5.5 1.3k"],
      ["Cost categories", `Responses ${amount}`],
    ]);
    const trend = view.container.querySelector(".provider-usage__trend")!;
    expect(trend.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Daily provider cost",
    );
    expect(trend.textContent).toBe("43 requests · 1.1k input · 400 cache · 260 output");
  });

  it("draws non-finite and signed amounts as zero without mutating the snapshot", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-07T12:00:00Z"));
      const today = "2026-09-07";
      const usage = {
        windows: [],
        costHistory: {
          unit: "credits",
          periodDays: 30,
          daily: [
            dailyUsage(today, 2, { cacheReadTokens: 2 ** 53 }),
            dailyUsage(today, Number.NaN, { cacheReadTokens: 1, cacheWriteTokens: -(2 ** 53) }),
            dailyUsage(today, -0),
          ],
          models: [],
          categories: [],
        },
      };
      const before = structuredClone(usage);
      const view = mountSolid(() => <ProviderUsagePanel usage={usage} />);
      const path = view.container.querySelector(".oc-sparkline-line")?.getAttribute("d");
      expect(path).toBe("M0 3.0 H40.0 V27.0 H80.0 V27.0 H120.0");
      expect(rowValues(view.container).map(([, value]) => value)).toEqual([
        "NaN credits",
        "NaN credits",
        "NaN credits",
      ]);
      expect(view.container.querySelector(".provider-usage__trend")?.textContent).toContain(
        "0 cache",
      );
      expect(usage).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
