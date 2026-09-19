import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetAcpMaintenanceWarningCoalescingForTesting,
  resolveAcpSessionActorKeySafe,
} from "./task-registry-acp-cleanup.js";
import {
  resetTaskRegistryMaintenanceRuntimeForTests,
  runTaskRegistryMaintenance,
  stopTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";
import {
  configureTaskRegistryMaintenanceRuntimeForTest,
  createAcpSessionStoreEntry,
} from "./task-registry.maintenance.test-support.js";
import { createTaskFixture } from "./task-registry.test-support.js";
import type { TaskRecord } from "./task-registry.types.js";

describe("task-registry maintenance ACP cleanup diagnostics and coalescing", () => {
  beforeEach(() => {
    resetAcpMaintenanceWarningCoalescingForTesting();
  });

  afterEach(() => {
    stopTaskRegistryMaintenance();
    resetTaskRegistryMaintenanceRuntimeForTests();
    resetAcpMaintenanceWarningCoalescingForTesting();
  });

  it("deduplicates terminal and orphaned ACP cleanup in the same maintenance sweep when close fails", async () => {
    const parentSessionKey = "agent:main:telegram:direct:owner";
    const childSessionKey = "agent:claude:acp:failed-close";
    const now = Date.now();
    const terminal = createTaskFixture("acp", {
      ownerKey: parentSessionKey,
      requesterSessionKey: parentSessionKey,
      childSessionKey,
      runId: "run-failed-acp-dedup",
      task: "Terminal ACP task that fails to close",
      status: "succeeded",
      deliveryStatus: "delivered",
    });
    const terminalCurrent: TaskRecord = {
      ...terminal,
      endedAt: now - 60_000,
      lastEventAt: now - 60_000,
    };
    const closeError = new Error("SESSION_OWNER_MIGRATION_REQUIRED");
    const closeAcpSession = vi.fn().mockRejectedValue(closeError);
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];

    configureTaskRegistryMaintenanceRuntimeForTest({
      currentTasks: new Map([[terminal.taskId, terminalCurrent]]),
      snapshotTasks: [terminalCurrent],
      acpEntries: [
        createAcpSessionStoreEntry({
          sessionKey: childSessionKey,
          parentSessionKey,
          mode: "oneshot",
        }),
      ],
      closeAcpSession,
      logWarn: (message, meta) => {
        warnings.push({ message, meta });
      },
    });

    await runTaskRegistryMaintenance();

    // Exactly 1 close attempt in the sweep, not 2 (orphan pass is deduplicated).
    expect(closeAcpSession).toHaveBeenCalledTimes(1);
    expect(closeAcpSession).toHaveBeenCalledWith({
      cfg: {},
      sessionKey: childSessionKey,
      reason: "terminal-task-cleanup",
    });
    // Diagnostic warning includes sessionKey, agentId, taskId, and error.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      message: "Failed to close terminal ACP session during task maintenance",
      meta: {
        sessionKey: childSessionKey,
        agentId: "claude",
        taskId: terminal.taskId,
        error: closeError,
      },
    });
  });

  it("coalesces unchanged ACP cleanup failure warnings across consecutive maintenance sweeps while preserving retries", async () => {
    const parentSessionKey = "agent:main:telegram:direct:owner";
    const childSessionKey = "agent:claude:acp:coalesce-warnings";
    const now = Date.now();
    const terminal = createTaskFixture("acp", {
      ownerKey: parentSessionKey,
      requesterSessionKey: parentSessionKey,
      childSessionKey,
      runId: "run-failed-acp-coalesce",
      task: "Terminal ACP task repeating failure",
      status: "succeeded",
      deliveryStatus: "delivered",
    });
    const terminalCurrent: TaskRecord = {
      ...terminal,
      endedAt: now - 60_000,
      lastEventAt: now - 60_000,
    };
    let currentError = new Error("SESSION_OWNER_MIGRATION_REQUIRED");
    const closeAcpSession = vi.fn().mockImplementation(async () => {
      throw currentError;
    });
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];

    configureTaskRegistryMaintenanceRuntimeForTest({
      currentTasks: new Map([[terminal.taskId, terminalCurrent]]),
      snapshotTasks: [terminalCurrent],
      acpEntries: [
        createAcpSessionStoreEntry({
          sessionKey: childSessionKey,
          parentSessionKey,
          mode: "oneshot",
        }),
      ],
      closeAcpSession,
      logWarn: (message, meta) => {
        warnings.push({ message, meta });
      },
    });

    // Sweep 1: First failure emits warning.
    await runTaskRegistryMaintenance();
    expect(closeAcpSession).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe(
      "Failed to close terminal ACP session during task maintenance",
    );
    expect(warnings[0]?.meta).toMatchObject({
      sessionKey: childSessionKey,
      agentId: "claude",
      taskId: terminal.taskId,
      error: currentError,
    });

    // Sweep 2: Unchanged error retries close but coalesces warning.
    await runTaskRegistryMaintenance();
    expect(closeAcpSession).toHaveBeenCalledTimes(2);
    expect(warnings).toHaveLength(1);

    // Sweep 3: Changed error signature emits new warning.
    currentError = new Error("ECONNREFUSED");
    await runTaskRegistryMaintenance();
    expect(closeAcpSession).toHaveBeenCalledTimes(3);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]?.meta?.error).toBe(currentError);

    // Sweep 4: Succeeded close resets failure tracking.
    closeAcpSession.mockResolvedValueOnce(undefined);
    await runTaskRegistryMaintenance();
    expect(closeAcpSession).toHaveBeenCalledTimes(4);
    expect(warnings).toHaveLength(2);

    // Sweep 5: Subsequent failure warns again because state was cleared on success.
    currentError = new Error("ECONNREFUSED");
    await runTaskRegistryMaintenance();
    expect(closeAcpSession).toHaveBeenCalledTimes(5);
    expect(warnings).toHaveLength(3);
  });

  it("coalesces unchanged orphaned ACP cleanup failure warnings and includes agentId in diagnostics", async () => {
    const parentSessionKey = "agent:main:telegram:direct:owner";
    const childSessionKey = "agent:claude:acp:orphan-coalesce";
    const currentError = new Error("SESSION_OWNER_MIGRATION_REQUIRED");
    const closeAcpSession = vi.fn().mockImplementation(async () => {
      throw currentError;
    });
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];

    configureTaskRegistryMaintenanceRuntimeForTest({
      currentTasks: new Map(),
      snapshotTasks: [],
      acpEntries: [
        createAcpSessionStoreEntry({
          sessionKey: childSessionKey,
          parentSessionKey,
          mode: "oneshot",
        }),
      ],
      closeAcpSession,
      logWarn: (message, meta) => {
        warnings.push({ message, meta });
      },
    });

    // Sweep 1: First orphan failure logs diagnostic with agentId.
    await runTaskRegistryMaintenance();
    expect(closeAcpSession).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      message: "Failed to close orphaned parent-owned ACP session during task maintenance",
      meta: {
        sessionKey: childSessionKey,
        agentId: "claude",
        error: currentError,
      },
    });

    // Sweep 2: Unchanged failure retried but coalesced.
    await runTaskRegistryMaintenance();
    expect(closeAcpSession).toHaveBeenCalledTimes(2);
    expect(warnings).toHaveLength(1);
  });

  it("coalesces unchanged unbind failure warnings when unbinding fails", async () => {
    const parentSessionKey = "agent:main:telegram:direct:owner";
    const childSessionKey = "agent:claude:acp:unbind-failure";
    const now = Date.now();
    const terminal = createTaskFixture("acp", {
      ownerKey: parentSessionKey,
      requesterSessionKey: parentSessionKey,
      childSessionKey,
      runId: "run-failed-unbind",
      task: "Terminal ACP task unbind failure",
      status: "succeeded",
      deliveryStatus: "delivered",
    });
    const terminalCurrent: TaskRecord = {
      ...terminal,
      endedAt: now - 60_000,
      lastEventAt: now - 60_000,
    };
    const closeAcpSession = vi.fn().mockResolvedValue(undefined);
    const unbindError = new Error("database lock timeout");
    const unbindSessionBindings = vi.fn().mockRejectedValue(unbindError);
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];

    configureTaskRegistryMaintenanceRuntimeForTest({
      currentTasks: new Map([[terminal.taskId, terminalCurrent]]),
      snapshotTasks: [terminalCurrent],
      acpEntries: [
        createAcpSessionStoreEntry({
          sessionKey: childSessionKey,
          parentSessionKey,
          mode: "oneshot",
        }),
      ],
      closeAcpSession,
      unbindSessionBindings,
      logWarn: (message, meta) => {
        warnings.push({ message, meta });
      },
    });

    // Sweep 1: Unbind fails and emits diagnostic warning.
    await runTaskRegistryMaintenance();
    expect(closeAcpSession).toHaveBeenCalledTimes(1);
    expect(unbindSessionBindings).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      message: "Failed to unbind terminal ACP session during task maintenance",
      meta: {
        sessionKey: childSessionKey,
        agentId: "claude",
        taskId: terminal.taskId,
        error: unbindError,
      },
    });

    // Sweep 2: Unchanged unbind failure is retried but warning coalesced.
    await runTaskRegistryMaintenance();
    expect(closeAcpSession).toHaveBeenCalledTimes(2);
    expect(unbindSessionBindings).toHaveBeenCalledTimes(2);
    expect(warnings).toHaveLength(1);
  });

  it("handles fallback actor key safely when target resolution throws", () => {
    const fallbackKey = resolveAcpSessionActorKeySafe({
      cfg: {} as never,
      sessionKey: "",
      agentId: "claude",
    });
    expect(fallbackKey).toBe("session::agent:claude");
  });
});
