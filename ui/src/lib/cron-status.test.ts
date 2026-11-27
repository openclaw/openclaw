// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { resolveCronJobAttention } from "./cron-status.ts";

function failedJob(enabled: boolean): CronJob {
  return {
    enabled,
    state: { lastRunStatus: "error" },
  } as CronJob;
}

describe("resolveCronJobAttention", () => {
  it("reports only enabled failed jobs as actionable", () => {
    expect(resolveCronJobAttention(failedJob(true))).toBe("error");
    expect(resolveCronJobAttention(failedJob(false))).toBeUndefined();
  });

  it("keeps auto-disabled jobs visible as failures", () => {
    // Auto-disable is the escalated failure state; without this the job drops
    // out of every failure surface at the moment the problem became permanent.
    const job = failedJob(false);
    job.state = {
      ...job.state,
      autoDisabled: { reason: "consecutive-failures", atMs: 1, consecutiveErrors: 10 },
    };
    expect(resolveCronJobAttention(job)).toBe("error");
  });

  it("keeps an operator pause and an execution failure distinct from retained task attention", () => {
    const job = failedJob(false);
    job.state.lastMeaningfulResult = { outcome: "blocked", summary: "Input required", atMs: 1 };
    expect(resolveCronJobAttention(job)).toBeUndefined();
    job.enabled = true;
    expect(resolveCronJobAttention(job)).toBe("error");
  });
});
