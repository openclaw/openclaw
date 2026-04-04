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
}) {
  vi.resetModules();

  const sessionStore = params.sessionStore ?? {};
  const acpEntry = params.acpEntry;
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
  it("marks cron tasks with no child session key lost after the grace period", async () => {
    const task = makeStaleTask({
      runtime: "cron",
      childSessionKey: undefined,
    });

    const { mod, currentTasks } = await loadMaintenanceModule({ tasks: [task] });

    expect(await mod.runTaskRegistryMaintenance()).toMatchObject({ reconciled: 1 });
    expect(currentTasks.get(task.taskId)).toMatchObject({ status: "lost" });
  });

  it("marks cron tasks lost even if their transient child key still exists in the session store", async () => {
    const childSessionKey = "agent:main:slack:channel:test-channel";
    const task = makeStaleTask({
      runtime: "cron",
      childSessionKey,
    });

    const { mod, currentTasks } = await loadMaintenanceModule({
      tasks: [task],
      sessionStore: { [childSessionKey]: { updatedAt: Date.now() } },
    });

    expect(await mod.runTaskRegistryMaintenance()).toMatchObject({ reconciled: 1 });
    expect(currentTasks.get(task.taskId)).toMatchObject({ status: "lost" });
  });

  it("treats cli tasks backed only by a persistent chat session as stale", async () => {
    const channelKey = "agent:main:slack:channel:C1234567890";
    const task = makeStaleTask({
      runtime: "cli",
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

  it("keeps subagent tasks live while their child session still exists", async () => {
    const childKey = "agent:main:subagent:abc123";
    const task = makeStaleTask({
      runtime: "subagent",
      ownerKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      childSessionKey: childKey,
    });

    const { mod, currentTasks } = await loadMaintenanceModule({
      tasks: [task],
      sessionStore: { [childKey]: { updatedAt: Date.now() } },
    });

    expect(await mod.runTaskRegistryMaintenance()).toMatchObject({ reconciled: 0 });
    expect(currentTasks.get(task.taskId)).toMatchObject({ status: "running" });
  });
});
