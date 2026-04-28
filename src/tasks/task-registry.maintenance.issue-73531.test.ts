import { afterEach, describe, expect, it } from "vitest";
import type { AcpSessionStoreEntry } from "../acp/runtime/session-meta.js";
import type { SessionEntry } from "../config/sessions.js";
import type { ParsedAgentSessionKey } from "../routing/session-key.js";
import {
  getInspectableTaskAuditSummary,
  getInspectableTaskRegistrySummary,
  reconcileInspectableTasks,
  resetTaskRegistryMaintenanceRuntimeForTests,
  setTaskRegistryMaintenanceRuntimeForTests,
  stopTaskRegistryMaintenanceForTests,
} from "./task-registry.maintenance.js";
import type { TaskRecord } from "./task-registry.types.js";

type TaskRegistryMaintenanceRuntime = Parameters<
  typeof setTaskRegistryMaintenanceRuntimeForTests
>[0];

afterEach(() => {
  stopTaskRegistryMaintenanceForTests();
  resetTaskRegistryMaintenanceRuntimeForTests();
});

function makeTask(overrides: Partial<TaskRecord>): TaskRecord {
  const now = Date.now();
  return {
    taskId: "task-test-" + Math.random().toString(36).slice(2),
    runtime: "subagent",
    requesterSessionKey: "agent:main:main",
    ownerKey: "system:test",
    scopeKind: "system",
    task: "test task",
    status: "succeeded",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: now - 60_000,
    startedAt: now - 60_000,
    lastEventAt: now - 60_000,
    endedAt: now - 60_000,
    cleanupAfter: now + 60_000,
    ...overrides,
  };
}

function installCountingRuntime(tasks: TaskRecord[]): { listCalls: () => number } {
  let listCallCount = 0;
  const runtime: TaskRegistryMaintenanceRuntime = {
    listAcpSessionEntries: async () => [],
    readAcpSessionEntry: () =>
      ({
        cfg: {} as never,
        storePath: "",
        sessionKey: "",
        storeSessionKey: "",
        entry: undefined,
        storeReadFailed: false,
      }) satisfies AcpSessionStoreEntry,
    loadSessionStore: () => ({}) as Record<string, SessionEntry>,
    resolveStorePath: () => "",
    isCronJobActive: () => false,
    getAgentRunContext: () => undefined,
    parseAgentSessionKey: (sessionKey: string | null | undefined): ParsedAgentSessionKey | null => {
      if (!sessionKey) {
        return null;
      }
      const [kind, agentId, ...rest] = sessionKey.split(":");
      return kind === "agent" && agentId && rest.length > 0
        ? { agentId, rest: rest.join(":") }
        : null;
    },
    deleteTaskRecordById: () => false,
    ensureTaskRegistryReady: () => {},
    getTaskById: (taskId: string) => tasks.find((task) => task.taskId === taskId),
    listTaskRecords: () => {
      listCallCount += 1;
      return tasks.map((task) => ({ ...task }));
    },
    markTaskLostById: () => null,
    markTaskTerminalById: () => null,
    maybeDeliverTaskTerminalUpdate: async () => null,
    resolveTaskForLookupToken: () => undefined,
    setTaskCleanupAfterById: () => null,
    isCronRuntimeAuthoritative: () => false,
    resolveCronStorePath: () => "/tmp/openclaw-test-cron/jobs.json",
    loadCronStoreSync: () => ({ version: 1, jobs: [] }),
    resolveCronRunLogPath: ({ jobId }) => jobId,
    readCronRunLogEntriesSync: () => [],
  };
  setTaskRegistryMaintenanceRuntimeForTests(runtime);
  return { listCalls: () => listCallCount };
}

describe("task-registry maintenance issue #73531", () => {
  it("reconciles tasks exactly once when summaries reuse a shared snapshot", () => {
    const { listCalls } = installCountingRuntime([
      makeTask({ taskId: "task-1", status: "succeeded" }),
      // Terminal task with no cleanupAfter trips the missing_cleanup audit warning
      // so the audit summary returns non-trivial findings and we can assert the
      // shared snapshot reaches the audit helper end-to-end.
      makeTask({
        taskId: "task-2",
        status: "failed",
        error: "boom",
        cleanupAfter: undefined,
      }),
    ]);

    const snapshot = reconcileInspectableTasks();
    const registry = getInspectableTaskRegistrySummary(snapshot);
    const audit = getInspectableTaskAuditSummary(snapshot);

    expect(listCalls()).toBe(1);
    expect(registry.total).toBe(2);
    expect(registry.failures).toBe(1);
    expect(audit.byCode.missing_cleanup).toBe(1);
    expect(audit.warnings).toBeGreaterThanOrEqual(1);
  });

  it("falls back to reconciling when no snapshot is supplied", () => {
    const { listCalls } = installCountingRuntime([
      makeTask({ taskId: "task-zero-arg", status: "succeeded" }),
    ]);

    const registry = getInspectableTaskRegistrySummary();
    const audit = getInspectableTaskAuditSummary();

    expect(listCalls()).toBe(2);
    expect(registry.total).toBe(1);
    expect(audit).toBeDefined();
  });
});
