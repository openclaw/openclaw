import { describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "./task-registry.types.js";

const GRACE_EXPIRED_MS = 10 * 60_000;

function makeStaleTask(overrides: Partial<TaskRecord>): TaskRecord {
  const now = Date.now();
  return {
    taskId: "task-test-" + Math.random().toString(36).slice(2),
    runtime: "cron",
    requesterSessionKey: "agent:main:main",
    ownerKey: "system:cron:test",
    scopeKind: "system",
    task: "test task",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: now - GRACE_EXPIRED_MS,
    startedAt: now - GRACE_EXPIRED_MS,
    lastEventAt: now - GRACE_EXPIRED_MS,
    ...overrides,
  };
}

async function loadMaintenanceModule(params: {
  tasks: TaskRecord[];
  sessionStore?: Record<string, unknown>;
  acpEntry?: unknown;
  activeCronJobIds?: string[];
  activeRunIds?: string[];
}) {
  vi.resetModules();

  const sessionStore = params.sessionStore ?? {};
  const acpEntry = params.acpEntry;
  const activeCronJobIds = new Set(params.activeCronJobIds ?? []);
  const activeRunIds = new Set(params.activeRunIds ?? []);
  const currentTasks = new Map(params.tasks.map((task) => [task.taskId, { ...task }]));

  vi.doMock("../acp/runtime/session-meta.js", () => ({
    readAcpSessionEntry: () =>
      acpEntry !== undefined
        ? { entry: acpEntry, storeReadFailed: false }
        : { entry: undefined, storeReadFailed: false },
  }));

  vi.doMock("../config/sessions.js", () => ({
    loadSessionStore: () => sessionStore,
    resolveStorePath: () => "",
  }));

  vi.doMock("../cron/active-jobs.js", () => ({
    isCronJobActive: (jobId: string) => activeCronJobIds.has(jobId),
  }));

  vi.doMock("../infra/agent-events.js", () => ({
    getAgentRunContext: (runId: string) =>
      activeRunIds.has(runId) ? { sessionKey: "main" } : undefined,
  }));

  vi.doMock("./runtime-internal.js", () => ({
    deleteTaskRecordById: (taskId: string) => currentTasks.delete(taskId),
    ensureTaskRegistryReady: () => {},
    getTaskById: (taskId: string) => currentTasks.get(taskId),
    listTaskRecords: () => params.tasks,
    markTaskLostById: (patch: {
      taskId: string;
      endedAt: number;
      lastEventAt?: number;
      error?: string;
      cleanupAfter?: number;
    }) => {
      const current = currentTasks.get(patch.taskId);
      if (!current) {
        return null;
      }
      const next = {
        ...current,
        status: "lost" as const,
        endedAt: patch.endedAt,
        lastEventAt: patch.lastEventAt ?? patch.endedAt,
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.cleanupAfter !== undefined ? { cleanupAfter: patch.cleanupAfter } : {}),
      };
      currentTasks.set(patch.taskId, next);
      return next;
    },
    maybeDeliverTaskTerminalUpdate: () => false,
    resolveTaskForLookupToken: () => undefined,
    setTaskCleanupAfterById: (patch: { taskId: string; cleanupAfter: number }) => {
      const current = currentTasks.get(patch.taskId);
      if (!current) {
        return null;
      }
      const next = { ...current, cleanupAfter: patch.cleanupAfter };
      currentTasks.set(patch.taskId, next);
      return next;
    },
  }));

  const mod = await import("./task-registry.maintenance.js");
  return { mod, currentTasks };
}

describe("task-registry maintenance issue #60299", () => {
  it("marks stale cron tasks lost once the runtime no longer tracks the job as active", async () => {
    const childSessionKey = "agent:main:slack:channel:test-channel";
    const task = makeStaleTask({
      runtime: "cron",
      sourceId: "cron-job-1",
      childSessionKey,
    });

    const { mod, currentTasks } = await loadMaintenanceModule({
      tasks: [task],
      sessionStore: { [childSessionKey]: { updatedAt: Date.now() } },
    });

    expect(await mod.runTaskRegistryMaintenance()).toMatchObject({ reconciled: 1 });
    expect(currentTasks.get(task.taskId)).toMatchObject({ status: "lost" });
  });

  it("keeps active cron tasks live while the cron runtime still owns the job", async () => {
    const task = makeStaleTask({
      runtime: "cron",
      sourceId: "cron-job-2",
      childSessionKey: undefined,
    });

    const { mod, currentTasks } = await loadMaintenanceModule({
      tasks: [task],
      activeCronJobIds: ["cron-job-2"],
    });

    expect(await mod.runTaskRegistryMaintenance()).toMatchObject({ reconciled: 0 });
    expect(currentTasks.get(task.taskId)).toMatchObject({ status: "running" });
  });

  it("marks chat-backed cli tasks lost after the owning run context disappears", async () => {
    const channelKey = "agent:main:slack:channel:C1234567890";
    const task = makeStaleTask({
      runtime: "cli",
      sourceId: "run-chat-cli-stale",
      runId: "run-chat-cli-stale",
      ownerKey: "agent:main:main",
      requesterSessionKey: channelKey,
      childSessionKey: channelKey,
    });

    const { mod, currentTasks } = await loadMaintenanceModule({
      tasks: [task],
      sessionStore: { [channelKey]: { updatedAt: Date.now() } },
    });

    expect(await mod.runTaskRegistryMaintenance()).toMatchObject({ reconciled: 1 });
    expect(currentTasks.get(task.taskId)).toMatchObject({ status: "lost" });
  });

  it("keeps chat-backed cli tasks live while the owning run context is still active", async () => {
    const channelKey = "agent:main:slack:channel:C1234567890";
    const task = makeStaleTask({
      runtime: "cli",
      sourceId: "run-chat-cli-live",
      runId: "run-chat-cli-live",
      ownerKey: "agent:main:main",
      requesterSessionKey: channelKey,
      childSessionKey: channelKey,
    });

    const { mod, currentTasks } = await loadMaintenanceModule({
      tasks: [task],
      sessionStore: { [channelKey]: { updatedAt: Date.now() } },
      activeRunIds: ["run-chat-cli-live"],
    });

    expect(await mod.runTaskRegistryMaintenance()).toMatchObject({ reconciled: 0 });
    expect(currentTasks.get(task.taskId)).toMatchObject({ status: "running" });
  });
});
