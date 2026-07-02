// Control UI tests cover cron status derivation behavior.
import { describe, expect, it } from "vitest";
import { isCronJobActiveFailure, resolveCronJobLastRunStatus } from "./cron-status.ts";
import type { CronJob } from "./types.ts";

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job",
    name: "Job",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "test" },
    ...overrides,
  };
}

describe("isCronJobActiveFailure", () => {
  it("counts an enabled job whose last run errored", () => {
    expect(isCronJobActiveFailure(job({ state: { lastRunStatus: "error" } }))).toBe(true);
  });

  it("ignores a disabled job that retains historical error state", () => {
    const disabled = job({
      enabled: false,
      state: { lastRunStatus: "error", consecutiveErrors: 6, nextRunAtMs: undefined },
    });
    // Historical status is still preserved for detail views.
    expect(resolveCronJobLastRunStatus(disabled)).toBe("error");
    expect(isCronJobActiveFailure(disabled)).toBe(false);
  });

  it("does not count enabled jobs whose last run succeeded or is unknown", () => {
    expect(isCronJobActiveFailure(job({ state: { lastRunStatus: "ok" } }))).toBe(false);
    expect(isCronJobActiveFailure(job())).toBe(false);
  });
});
