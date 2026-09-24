import { describe, expect, it } from "vitest";
import {
  collectBlacksmithBudget,
  consumeBlacksmithBudgetReport,
} from "../../scripts/ci-blacksmith-budget.mjs";

const repository = "openclaw/openclaw";
const now = Date.parse("2026-09-23T12:00:00Z");

function usage(costUsd = 14_999.99) {
  const summary = {
    jobs: 3,
    billable_minutes: 4_000_000,
    billing_minutes: 7_499_995,
    runtime_minutes: 250_000,
    cost_usd: costUsd,
  };
  return {
    window: { start: "2026-09-01T00:00:00Z", end: "2026-09-23T12:00:00Z" },
    installation: { installation_model_id: 17, installation_name: "openclaw" },
    summary,
    daily: [{ date: "2026-09-23", ...summary }],
    breakdowns: { repo: [{ repo: "private-project", ...summary }] },
  };
}

async function collect(value: unknown = usage()) {
  return collectBlacksmithBudget({ repository, now, readUsage: async () => value });
}

describe("Blacksmith native monthly budget", () => {
  it("uses the complete UTC month and org cost without a repository filter or list-rate repricing", async () => {
    const report = await collectBlacksmithBudget({
      repository,
      now,
      readUsage: async (args: string[]) => {
        expect(args).toEqual([
          "usage",
          "--org",
          "openclaw",
          "--start-time",
          "2026-09-01T00:00:00Z",
          "--end-time",
          "2026-09-23T12:00:00.000Z",
          "--breakdown-by",
          "day",
          "--limit",
          "31",
          "--format",
          "json",
        ]);
        return usage();
      },
    });
    expect(report).toMatchObject({
      complete: true,
      blacksmithAllowed: true,
      costUsd: 14_999.99,
      vcpuMinutes: 4_000_000,
      billingMinutes: 7_499_995,
      runtimeMinutes: 250_000,
      closeAtUsd: 15_000,
      blacksmithJobs: 3,
    });
    expect(JSON.stringify(report)).not.toContain("private-project");
    expect(report).not.toHaveProperty("installation");
    expect(report).not.toHaveProperty("breakdowns");
  });

  it.each([15_000, 15_000.01, 620_935.768])(
    "closes routing at or above the threshold: $%s",
    async (costUsd) => {
      expect(await collect(usage(costUsd))).toMatchObject({
        complete: true,
        blacksmithAllowed: false,
        reason: "monthly-threshold-reached",
        costUsd,
      });
    },
  );

  it.each([
    ["another organization", { ...usage(), installation: { installation_name: "other" } }],
    [
      "shortened month",
      { ...usage(), window: { ...usage().window, start: "2026-09-02T00:00:00Z" } },
    ],
    ["stale window", { ...usage(), window: { ...usage().window, end: "2026-09-23T11:00:00Z" } }],
    ["invalid date", { ...usage(), window: { ...usage().window, start: "2026-09-00T00:00:00Z" } }],
    ["missing daily aggregate", { ...usage(), daily: undefined }],
    ["incomplete daily aggregate", { ...usage(), daily: [] }],
    ["duplicate day", { ...usage(), daily: [...usage().daily, ...usage().daily] }],
    ["day outside month", { ...usage(), daily: [{ ...usage().daily[0], date: "2026-08-31" }] }],
    ["future day", { ...usage(), daily: [{ ...usage().daily[0], date: "2026-09-24" }] }],
    ["negative cost", usage(-1)],
    ["non-numeric cost", { ...usage(), summary: { ...usage().summary, cost_usd: "0" } }],
    [
      "missing platform-weighted minutes",
      { ...usage(), summary: { ...usage().summary, billing_minutes: undefined } },
    ],
  ])("denies uncertainty: %s", async (_name, value) => {
    expect(await collect(value)).toMatchObject({
      complete: false,
      blacksmithAllowed: false,
      reason: "native-usage-unavailable",
      costUsd: null,
    });
  });

  it("accepts an independently consistent empty month", async () => {
    const report = await collect({
      ...usage(),
      summary: {
        jobs: 0,
        billable_minutes: 0,
        billing_minutes: 0,
        runtime_minutes: 0,
        cost_usd: 0,
      },
      daily: [],
    });
    expect(report).toMatchObject({ complete: true, blacksmithAllowed: true, costUsd: 0 });
  });

  it("keeps provider errors and credentials out of the public report", async () => {
    const report = await collectBlacksmithBudget({
      repository,
      now,
      readUsage: async () => {
        throw new Error("transport failure containing private request authorization");
      },
    });
    expect(report).toMatchObject({
      complete: false,
      blacksmithAllowed: false,
      reason: "native-usage-unavailable",
    });
    expect(JSON.stringify(report)).not.toContain("authorization");
  });

  it("admits only current, complete, fresh reports with the correct source and policy", async () => {
    const report = await collect();
    expect(consumeBlacksmithBudgetReport({ report, repository, now }).blacksmithAllowed).toBe(true);
    for (const changed of [
      undefined,
      { ...report, version: 1 },
      { ...report, source: "actions-projection" },
      { ...report, repository: "other/repository" },
      { ...report, organization: "other" },
      { ...report, month: "2026-08" },
      { ...report, complete: false },
      { ...report, closeAtUsd: 20_000 },
      { ...report, costUsd: Number.NaN },
      { ...report, costUsd: 15_000 },
      { ...report, blacksmithAllowed: false },
      { ...report, sourceCutoff: "2026-09-23T10:59:59Z" },
      { ...report, sourceCutoff: "2026-09-23T12:00:01Z" },
      { ...report, generatedAt: "2026-09-23T12:00:01Z" },
    ]) {
      expect(
        consumeBlacksmithBudgetReport({ report: changed, repository, now }).blacksmithAllowed,
      ).toBe(false);
    }
    expect(
      consumeBlacksmithBudgetReport({
        report,
        repository,
        now: Date.parse("2026-10-01T00:00:00Z"),
      }).blacksmithAllowed,
    ).toBe(false);
  });
});
