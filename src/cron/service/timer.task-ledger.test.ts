// Cron service timer task-ledger coverage (split from timer.test.ts for max-lines).
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../../cron/service.test-harness.js";
import { createCronServiceState as createCronServiceStateBase } from "../../cron/service/state.js";
import { onTimer } from "../../cron/service/timer.test-support.js";
import type { CronJob } from "../../cron/types.js";
import * as taskExecutor from "../../tasks/task-executor.js";
import { findTaskByRunId, listTaskRecordsUnsorted } from "../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { formatTaskStatusDetail } from "../../tasks/task-status.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-timer-task-ledger",
});

function createCronServiceState(
  params: Parameters<typeof createCronServiceStateBase>[0],
): ReturnType<typeof createCronServiceStateBase> {
  return createCronServiceStateBase({ defaultAgentId: "main", ...params });
}

function createDueMainJob(params: { now: number; wakeMode: CronJob["wakeMode"] }): CronJob {
  return {
    id: "main-heartbeat-job",
    name: "main heartbeat job",
    enabled: true,
    createdAtMs: params.now - 60_000,
    updatedAtMs: params.now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: params.now - 60_000 },
    sessionTarget: "main",
    wakeMode: params.wakeMode,
    payload: { kind: "systemEvent", text: "heartbeat seam tick" },
    sessionKey: "agent:main:main",
    state: { nextRunAtMs: params.now - 1 },
  };
}

function createDueIsolatedAgentJob(params: { now: number }): CronJob {
  return {
    id: "isolated-agent-job",
    agentId: "finn",
    name: "isolated agent job",
    enabled: true,
    createdAtMs: params.now - 60_000,
    updatedAtMs: params.now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: params.now - 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "run isolated cron" },
    state: { nextRunAtMs: params.now - 1 },
  };
}

function findCronTaskByBaseRunId(baseRunId: string) {
  return (
    findTaskByRunId(baseRunId) ??
    listTaskRecordsUnsorted().find((task) => task.runId?.startsWith(`${baseRunId}:`))
  );
}

afterEach(() => {
  resetTaskRegistryForTests();
});

describe("cron service timer task ledger coverage", () => {
  it("records isolated cron task runs against the backing cron session", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      sessionId: "session-run-1",
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
      storePath,
      cronEnabled: true,
      log: logger,
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
      storePath,
      cronEnabled: true,
      log: logger,
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
    let resolveRun: ((value: { status: "ok"; summary: string }) => void) | undefined;
    const runIsolatedAgentJob = vi.fn(
      () =>
        new Promise<{ status: "ok"; summary: string }>((resolve) => {
          resolveRun = resolve;
        }),
    );

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueIsolatedAgentJob({ now })],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob,
    });

    const timerRun = onTimer(state);
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

    resolveRun?.({ status: "ok", summary: "done" });
    await timerRun;
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
      storePath,
      cronEnabled: true,
      log: logger,
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
    const cronRunSessionKey = `agent:main:cron:main-heartbeat-job:run:${now}`;
    expect(enqueueSystemEvent).toHaveBeenCalledWith("heartbeat seam tick", {
      agentId: undefined,
      sessionKey: cronRunSessionKey,
      contextKey: "cron:main-heartbeat-job",
    });

    createTaskRecordSpy.mockRestore();
  });
});
