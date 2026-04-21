import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { createGatewayReloadHandlers } from "./server-reload-handlers.js";

const hoisted = vi.hoisted(() => {
  const activeEmbeddedRunCount = { value: 0 };
  const pendingReplies = { value: 0 };
  const queueSize = { value: 0 };
  const tasks: TaskRecord[] = [];
  const deferGatewayRestartUntilIdle = vi.fn();
  const emitGatewayRestart = vi.fn(() => true);
  const setGatewaySigusr1RestartPolicy = vi.fn();
  const runTaskRegistryMaintenance = vi.fn(async () => ({
    reconciled: 0,
    recovered: 0,
    cleanupStamped: 0,
    pruned: 0,
  }));
  const markTaskLostById = vi.fn(
    (params: { taskId: string; endedAt: number; lastEventAt?: number; error?: string }) => {
      const task = tasks.find((candidate) => candidate.taskId === params.taskId);
      if (!task) {
        return null;
      }
      task.status = "lost";
      task.endedAt = params.endedAt;
      task.lastEventAt = params.lastEventAt;
      task.error = params.error;
      return task;
    },
  );
  return {
    activeEmbeddedRunCount,
    pendingReplies,
    queueSize,
    tasks,
    deferGatewayRestartUntilIdle,
    emitGatewayRestart,
    markTaskLostById,
    runTaskRegistryMaintenance,
    setGatewaySigusr1RestartPolicy,
  };
});

vi.mock("../agents/pi-embedded-runner/runs.js", () => ({
  getActiveEmbeddedRunCount: () => hoisted.activeEmbeddedRunCount.value,
}));

vi.mock("../auto-reply/reply/dispatcher-registry.js", () => ({
  getTotalPendingReplies: () => hoisted.pendingReplies.value,
}));

vi.mock("../infra/restart.js", () => ({
  deferGatewayRestartUntilIdle: hoisted.deferGatewayRestartUntilIdle,
  emitGatewayRestart: hoisted.emitGatewayRestart,
  setGatewaySigusr1RestartPolicy: hoisted.setGatewaySigusr1RestartPolicy,
}));

vi.mock("../process/command-queue.js", () => ({
  getTotalQueueSize: () => hoisted.queueSize.value,
  setCommandLaneConcurrency: vi.fn(),
}));

vi.mock("../tasks/task-registry.js", () => ({
  listTaskRecords: () => hoisted.tasks,
  markTaskLostById: hoisted.markTaskLostById,
}));

vi.mock("../tasks/task-registry.maintenance.js", () => ({
  getInspectableTaskRegistrySummary: () => {
    const active = hoisted.tasks.filter(
      (task) => task.status === "queued" || task.status === "running",
    ).length;
    return {
      total: hoisted.tasks.length,
      active,
      terminal: hoisted.tasks.length - active,
      failures: 0,
      byStatus: {
        queued: 0,
        running: active,
        succeeded: 0,
        failed: 0,
        timed_out: 0,
        cancelled: 0,
        lost: 0,
      },
      byRuntime: {
        subagent: active,
        acp: 0,
        cli: 0,
        cron: 0,
      },
    };
  },
  runTaskRegistryMaintenance: hoisted.runTaskRegistryMaintenance,
}));

function createTask(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    taskId: "task-stale",
    runtime: "subagent",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    childSessionKey: "agent:main:subagent:worker",
    task: "stale worker",
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "silent",
    createdAt: Date.now(),
    ...overrides,
  };
}

function createReloadHandlers(logReload: {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
}) {
  return createGatewayReloadHandlers({
    deps: {} as Parameters<typeof createGatewayReloadHandlers>[0]["deps"],
    broadcast: vi.fn(),
    getState: vi.fn(
      () =>
        ({
          hooksConfig: {},
          hookClientIpConfig: {},
          heartbeatRunner: { updateConfig: vi.fn() },
          cronState: {
            cron: { stop: vi.fn() },
          },
          channelHealthMonitor: null,
        }) as ReturnType<Parameters<typeof createGatewayReloadHandlers>[0]["getState"]>,
    ),
    setState: vi.fn(),
    startChannel: vi.fn(),
    stopChannel: vi.fn(),
    logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logChannels: { info: vi.fn(), error: vi.fn() },
    logCron: { error: vi.fn() },
    logReload,
    createHealthMonitor: vi.fn(() => null),
  });
}

describe("createGatewayReloadHandlers", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    hoisted.activeEmbeddedRunCount.value = 0;
    hoisted.pendingReplies.value = 0;
    hoisted.queueSize.value = 0;
    hoisted.tasks.length = 0;
    hoisted.deferGatewayRestartUntilIdle.mockClear();
    hoisted.emitGatewayRestart.mockClear();
    hoisted.markTaskLostById.mockClear();
    hoisted.runTaskRegistryMaintenance.mockClear();
    hoisted.setGatewaySigusr1RestartPolicy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("force-reaps stale active tasks on reload timeout before logging remaining active work", async () => {
    const now = Date.now();
    hoisted.tasks.push(createTask({ lastEventAt: now - 3_000 }));
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { requestGatewayRestart } = createReloadHandlers(logReload);
    const sigusr1Listener = vi.fn();
    process.on("SIGUSR1", sigusr1Listener);
    try {
      await expect(
        requestGatewayRestart(
          {
            changedPaths: ["gateway.port"],
            restartGateway: true,
            restartReasons: ["gateway.port"],
            hotReasons: [],
            reloadHooks: false,
            restartGmailWatcher: false,
            restartCron: false,
            restartHeartbeat: false,
            restartChannels: new Set(),
            noopPaths: [],
          },
          { gateway: { reload: { deferralTimeoutMs: 1_000 } } },
        ),
      ).resolves.toBe(true);

      const deferCall = hoisted.deferGatewayRestartUntilIdle.mock.calls.at(-1)?.[0];
      expect(deferCall).toBeDefined();
      deferCall?.hooks?.onTimeout?.(1, 1_000);
    } finally {
      process.off("SIGUSR1", sigusr1Listener);
    }

    expect(hoisted.runTaskRegistryMaintenance).toHaveBeenCalledTimes(1);
    expect(hoisted.markTaskLostById).toHaveBeenCalledWith({
      taskId: "task-stale",
      endedAt: now,
      lastEventAt: now,
      error: "reload-timeout-force-reap",
    });
    expect(logReload.warn).toHaveBeenCalledWith(
      "force-reaping stale task before reload taskId=task-stale ageMs=3000",
    );
    expect(logReload.warn).toHaveBeenCalledWith(
      "restart timeout after 1000ms; stale task registry entries reaped; restarting gateway now",
    );
  });
});
