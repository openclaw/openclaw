import { describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite } from "../service.test-harness.js";
import type { CronJob } from "../types.js";
import { createCronServiceState } from "./state.js";
import { executeJobCore } from "./timer-execution.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-command-task-identity-",
});

describe("command cron task identity", () => {
  it("passes runtime-owned identity without trusting payload env", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const runCommandJob = vi.fn(async () => ({ status: "ok" as const, summary: "command ok" }));
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      defaultAgentId: "main",
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runCommandJob,
    });
    const job: CronJob = {
      id: "command-job",
      name: "command job",
      enabled: true,
      createdAtMs: now - 60_000,
      updatedAtMs: now - 60_000,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "command",
        argv: ["true"],
        env: {
          OPENCLAW_CRON_TASK_ID: "attacker-task",
          OPENCLAW_CRON_TASK_RUN_ID: "attacker-run",
        },
      },
      state: { nextRunAtMs: now - 1 },
    };
    const taskIdentity = { taskId: "task-owned-by-runtime", runId: "run-owned-by-runtime" };

    await executeJobCore(state, job, undefined, { taskIdentity });

    expect(runCommandJob).toHaveBeenCalledWith({
      job,
      abortSignal: undefined,
      taskIdentity,
    });
  });
});
