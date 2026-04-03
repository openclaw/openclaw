/**
 * Regression tests for issue #60299:
 * Task Maintenance never cleans up stale tasks (hasBackingSession bug)
 *
 * Three bad paths were identified in hasBackingSession():
 * 1. runtime="cron" + blank childSessionKey → returned true (stale task kept alive)
 * 2. runtime="cron" + non-empty childSessionKey → no cron branch, returned true (stale task kept alive)
 * 3. runtime="cli" + childSessionKey pointing to a persistent channel session → returned true (stale task kept alive)
 */
import { describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "./task-registry.types.js";

const GRACE_EXPIRED_MS = 10 * 60_000; // 10 min >> 5 min grace

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

/**
 * Load a fresh copy of the maintenance module with mocked dependencies.
 * sessionStore: the fake session store contents to return from loadSessionStore()
 */
async function loadMaintenanceModule(params: {
  tasks: TaskRecord[];
  sessionStore?: Record<string, unknown>;
  acpEntry?: unknown;
}) {
  vi.resetModules();

  const sessionStore = params.sessionStore ?? {};
  const acpEntry = params.acpEntry;

  const currentTasks = new Map(params.tasks.map((t) => [t.taskId, { ...t }]));

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

describe("hasBackingSession — issue #60299 regression tests", () => {
  it("case 1: cron task with blank childSessionKey is stale (hasBackingSession = false)", async () => {
    // Bug: blank childSessionKey hit `return true` early — task was never marked lost.
    const task = makeStaleTask({
      runtime: "cron",
      childSessionKey: undefined,
    });

    const { mod, currentTasks } = await loadMaintenanceModule({ tasks: [task] });

    expect(await mod.runTaskRegistryMaintenance()).toMatchObject({ reconciled: 1 });
    expect(currentTasks.get(task.taskId)).toMatchObject({ status: "lost" });
  });

  it("case 2: cron task with non-empty childSessionKey is stale (hasBackingSession = false)", async () => {
    // Bug: no cron branch existed, fell through to `return true` — task was never marked lost.
    // Even if the key exists in the session store, cron tasks should always be considered stale.
    const key = "agent:main:slack:channel:test-channel";
    const task = makeStaleTask({
      runtime: "cron",
      childSessionKey: key,
    });

    const { mod, currentTasks } = await loadMaintenanceModule({
      tasks: [task],
      sessionStore: { [key]: { updatedAt: Date.now() } }, // session exists but shouldn't matter
    });

    expect(await mod.runTaskRegistryMaintenance()).toMatchObject({ reconciled: 1 });
    expect(currentTasks.get(task.taskId)).toMatchObject({ status: "lost" });
  });

  it("case 3: cli task with childSessionKey pointing to a live Slack channel session is stale (hasBackingSession = false)", async () => {
    // Bug: session-store lookup returned truthy for the persistent channel session,
    // so the task was never marked lost even though no actual task work was running.
    const channelKey = "agent:main:slack:channel:C1234567890";
    const task = makeStaleTask({
      runtime: "cli",
      ownerKey: "agent:main:main",
      requesterSessionKey: channelKey,
      childSessionKey: channelKey,
    });

    const { mod, currentTasks } = await loadMaintenanceModule({
      tasks: [task],
      sessionStore: { [channelKey]: { updatedAt: Date.now() } }, // channel session is alive
    });

    expect(await mod.runTaskRegistryMaintenance()).toMatchObject({ reconciled: 1 });
    expect(currentTasks.get(task.taskId)).toMatchObject({ status: "lost" });
  });

  it("case 4: subagent task with childSessionKey pointing to an actually running session is NOT stale (hasBackingSession = true)", async () => {
    // The fix must not regress the healthy subagent case.
    const childKey = "agent:main:subagent:abc123";
    const task = makeStaleTask({
      runtime: "subagent",
      ownerKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      childSessionKey: childKey,
    });

    const { mod, currentTasks } = await loadMaintenanceModule({
      tasks: [task],
      sessionStore: { [childKey]: { updatedAt: Date.now() } }, // subagent session is alive
    });

    expect(await mod.runTaskRegistryMaintenance()).toMatchObject({ reconciled: 0 });
    expect(currentTasks.get(task.taskId)).toMatchObject({ status: "running" });
  });
});
