import { describe, expect, it, vi } from "vitest";
import { createMockCronStateForJobs } from "./service.test-harness.js";
import { executeJob } from "./service/timer.js";
import type { CronJob } from "./types.js";

function createJob(overrides?: Partial<CronJob>): CronJob {
  return {
    id: "job-1",
    name: "Cron job",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Run task" },
    delivery: { mode: "none" },
    failureAlert: false,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    state: {},
    ...overrides,
  };
}

describe("executeJob procedural playbook memory wiring", () => {
  it("records error signals when a cron run fails", async () => {
    const job = createJob();
    const recordProceduralPlaybookSignal = vi.fn();
    const state = createMockCronStateForJobs({ jobs: [job], nowMs: 1_700_000_000_000 });
    state.deps.recordProceduralPlaybookSignal = recordProceduralPlaybookSignal;
    state.deps.runIsolatedAgentJob = vi.fn().mockResolvedValue({
      status: "error",
      error: "delivery target is missing",
      errorKind: "delivery-target",
    });

    await executeJob(state, job, 1_700_000_000_000, { forced: false });

    expect(recordProceduralPlaybookSignal).toHaveBeenCalledWith({
      jobId: "job-1",
      jobName: "Cron job",
      sessionTarget: "isolated",
      payloadKind: "agentTurn",
      status: "error",
      error: "delivery target is missing",
      errorKind: "delivery-target",
      occurredAtMs: 1_700_000_000_000,
    });
  });

  it("records recovery signals after a prior execution error", async () => {
    const job = createJob({
      state: {
        lastRunStatus: "error",
        lastError: "delivery target is missing",
      },
    });
    const recordProceduralPlaybookSignal = vi.fn();
    const state = createMockCronStateForJobs({ jobs: [job], nowMs: 1_700_000_000_000 });
    state.deps.recordProceduralPlaybookSignal = recordProceduralPlaybookSignal;
    state.deps.runIsolatedAgentJob = vi.fn().mockResolvedValue({
      status: "ok",
      summary: "Delivered",
    });

    await executeJob(state, job, 1_700_000_000_000, { forced: false });

    expect(recordProceduralPlaybookSignal).toHaveBeenCalledWith({
      jobId: "job-1",
      jobName: "Cron job",
      sessionTarget: "isolated",
      payloadKind: "agentTurn",
      status: "ok",
      error: "delivery target is missing",
      occurredAtMs: 1_700_000_000_000,
    });
  });
});
