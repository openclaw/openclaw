// Cron service timer tests cover task-ledger records for scheduled cron runs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../../cron/service.test-harness.js";
import { createCronServiceState as createCronServiceStateBase } from "../../cron/service/state.js";
import { onTimer } from "../../cron/service/timer.test-support.js";
import { getActiveGatewayRootWorkCount } from "../../process/gateway-work-admission.js";
import * as taskExecutor from "../../tasks/task-executor.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { formatTaskStatusDetail } from "../../tasks/task-status.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { getSuspensionVisibleCronTaskRunCount } from "./active-run-cancellation.js";
import { stop } from "./ops-lifecycle.js";
import {
  createDueIsolatedAgentJob,
  createDueMainJob,
  findCronTaskByBaseRunId,
} from "./timer.seam.test-support.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-timer-task-ledger",
});

function createCronServiceState(
  params: Omit<Parameters<typeof createCronServiceStateBase>[0], "cronEnabled" | "log">,
): ReturnType<typeof createCronServiceStateBase> {
  return createCronServiceStateBase({
    defaultAgentId: "main",
    cronEnabled: true,
    log: logger,
    ...params,
  });
}

afterEach(() => {
  resetTaskRegistryForTests();
});

describe("cron service timer task ledger", () => {
  it("records isolated cron task runs against the backing cron session", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      sessionId: "session-run-1",
      delivered: true,
      sessionKey: "agent:finn:cron:isolated-agent-job:run:run-1",
      delivery: { intended: { channel: "telegram", to: "42" } },
      model: "gpt-test",
      provider: "openai",
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    }));

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueIsolatedAgentJob({ now })],
    });

    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler(),
      storePath,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob,
    });

    await onTimer(state);

    expect(runIsolatedAgentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({ id: "isolated-agent-job" }),
        message: "run isolated cron",
      }),
    );
    const task = findCronTaskByBaseRunId(`cron:isolated-agent-job:${now}`);
    if (!task) {
      throw new Error("expected isolated cron task ledger record");
    }
    expect(task.childSessionKey).toBe("agent:finn:cron:isolated-agent-job:run:run-1");
    expect(task.status).toBe("succeeded");
    expect(task.terminalSummary).toBe("done");
    expect(task.detail).toMatchObject({
      kind: "cron-run",
      status: "ok",
      sessionId: "session-run-1",
      durationMs: 0,
      nextRunAtMs: now + 60_000,
      delivery: { intended: { channel: "telegram", to: "42" } },
      model: "gpt-test",
      provider: "openai",
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    });
  });

  it("records current-bound cron task runs against the backing cron session", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      sessionKey: "agent:finn:cron:isolated-agent-job:run:run-1",
      delivered: true,
    }));

    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          ...createDueIsolatedAgentJob({ now }),
          sessionTarget: "current",
          sessionKey: "agent:finn:telegram:direct:42",
        },
      ],
    });

    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler(),
      storePath,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    await onTimer(state);

    const task = findCronTaskByBaseRunId(`cron:isolated-agent-job:${now}`);
    if (!task) {
      throw new Error("expected current-bound cron task ledger record");
    }
    expect(task.childSessionKey).toBe("agent:finn:cron:isolated-agent-job:run:run-1");
    expect(task.status).toBe("succeeded");
  });

  it("seeds active scheduled cron task progress for status surfaces", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const runResult = createDeferred<{ status: "ok"; summary: string }>();
    const runIsolatedAgentJob = vi.fn(() => runResult.promise);

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueIsolatedAgentJob({ now })],
    });

    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler(),
      storePath,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob,
    });

    const timerRun = onTimer(state);
    try {
      await vi.waitFor(() => {
        expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      });

      const task = findCronTaskByBaseRunId(`cron:isolated-agent-job:${now}`);
      if (!task) {
        throw new Error("expected active cron task ledger record");
      }
      expect(task.status).toBe("running");
      expect(task.progressSummary).toBe("Running automation.");
      expect(formatTaskStatusDetail(task)).toBe("Running automation.");

      runResult.resolve({ status: "ok", summary: "done" });
      await timerRun;
    } finally {
      // Stop new ticks and settle this core before the shared hooks reset its state.
      stop(state);
      runResult.resolve({ status: "ok", summary: "done" });
      try {
        await timerRun;
      } finally {
        await vi.waitFor(() => {
          expect(getSuspensionVisibleCronTaskRunCount()).toBe(0);
          expect(getActiveGatewayRootWorkCount()).toBe(0);
        });
      }
    }
  });

  it("keeps scheduler progress when task ledger creation fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const ledgerError = new Error("disk full");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueMainJob({ now, wakeMode: "next-heartbeat" })],
    });

    const createTaskRecordSpy = vi
      .spyOn(taskExecutor, "createRunningTaskRunCore")
      .mockImplementation(() => {
        throw ledgerError;
      });

    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler(),
      storePath,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await onTimer(state);

    expect(logger.warn).toHaveBeenCalledWith(
      { jobId: "main-heartbeat-job", error: ledgerError },
      "cron: failed to create task ledger record",
    );
    expect(enqueueSystemEvent).toHaveBeenCalledWith("heartbeat seam tick", {
      agentId: "main",
      contextKey: "cron:main-heartbeat-job",
    });

    createTaskRecordSpy.mockRestore();
  });
});
