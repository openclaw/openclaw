/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { renderProviderUsageDetails } from "./provider-usage.tsx";

describe("Solid provider usage", () => {
  it("groups quota windows in rank order and presents remaining quota accessibly", () => {
    const view = mountSolid(() =>
      renderProviderUsageDetails(
        {
          windows: [
            { label: "Weekly", groupLabel: "Account A", usedPercent: 92 },
            { label: "5h", groupLabel: "Account A", usedPercent: 25 },
            { label: "Monthly", groupLabel: "Account B", usedPercent: 80 },
          ],
          summary: "Provider summary",
        },
        { groupWindows: true },
      ),
    );
    const group = view.container.querySelector('[role="group"][aria-label="Account A"]')!;
    const meters = [...group.querySelectorAll<HTMLElement>('[role="progressbar"]')];
    expect(
      meters.map((meter) => [
        meter.getAttribute("aria-label"),
        meter.getAttribute("aria-valuenow"),
      ]),
    ).toEqual([
      ["5h", "75"],
      ["Weekly", "8"],
    ]);
    expect(meters[0]?.querySelector<HTMLElement>("span")?.style.width).toBe("75%");
    expect(meters[1]?.classList.contains("provider-usage-progress--danger")).toBe(true);
    expect(view.container.textContent).toContain("Provider summary");
  });

  it("preserves provider cost, billing and chart values in rendered DOM", () => {
    const view = mountSolid(() =>
      renderProviderUsageDetails({
        windows: [],
        billing: [{ type: "budget", used: 2.5, limit: 10, unit: "USD" }],
        costHistory: {
          unit: "USD",
          periodDays: 30,
          daily: [
            {
              date: "2026-01-01",
              amount: 2.5,
              requests: 3,
              inputTokens: 1_000,
              cacheReadTokens: 400,
              cacheWriteTokens: 50,
              outputTokens: 250,
              totalTokens: 1_250,
            },
          ],
          models: [],
          categories: [{ name: "Responses", amount: 2.5 }],
        },
      }),
    );
    expect(view.container.querySelector(".provider-usage-billing strong")?.textContent).toBe(
      "$2.50 / $10.00",
    );
    const bar = view.container.querySelector<HTMLElement>('.provider-cost-chart [role="img"]')!;
    expect(bar.style.height).toBe("100%");
    expect(bar.getAttribute("aria-label")).toBe("2026-01-01: $2.50");
    expect(view.container.querySelector(".provider-cost-tokens")?.textContent).toContain(
      "3 requests",
    );
    expect(view.container.querySelector(".provider-cost-breakdown")?.textContent).toContain(
      "Responses$2.50",
    );
  });
});
