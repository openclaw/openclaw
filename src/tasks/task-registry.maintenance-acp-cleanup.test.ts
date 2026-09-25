import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { finalizeTaskRecordByRunId, getTaskById } from "./task-registry.js";
import { runTaskRegistryMaintenance } from "./task-registry.maintenance.js";
import {
  configureTaskRegistryMaintenanceRuntimeForTest,
  createAcpSessionStoreEntry,
  resetTaskRegistryMaintenanceMocks,
} from "./task-registry.maintenance.test-support.js";
import { createTaskFixture, withTaskRegistryTempDir } from "./task-registry.test-support.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

describe("task-registry ACP cleanup resume retention", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    resetTaskRegistryMaintenanceMocks();
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    resetTaskRegistryMaintenanceMocks();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("keeps terminal parent-owned one-shot ACP sessions with a stable resume identity", async () => {
    await withTaskRegistryTempDir(async () => {
      const now = Date.now();
      const parentSessionKey = "agent:main:telegram:direct:owner";
      const childSessionKey = "agent:claude:acp:resumable-oneshot";
      const task = createTaskFixture("acp", {
        ownerKey: parentSessionKey,
        requesterSessionKey: parentSessionKey,
        childSessionKey,
        runId: "run-terminal-acp-resumable-oneshot",
        task: "Resumable ACP task",
        status: "succeeded",
        deliveryStatus: "delivered",
        lastEventAt: now - 60_000,
      });
      finalizeTaskRecordByRunId({
        runId: "run-terminal-acp-resumable-oneshot",
        runtime: "acp",
        status: "succeeded",
        endedAt: now - 60_000,
        lastEventAt: now - 60_000,
      });
      const current = getTaskById(task.taskId)!;
      const closeAcpSession = vi.fn().mockResolvedValue(undefined);
      const unbindSessionBindings = vi.fn().mockResolvedValue([]);

      configureTaskRegistryMaintenanceRuntimeForTest({
        currentTasks: new Map([[task.taskId, current]]),
        snapshotTasks: [current],
        acpEntry: createAcpSessionStoreEntry({
          sessionKey: childSessionKey,
          parentSessionKey,
          mode: "oneshot",
          resumeSessionId: "claude-session-123",
          sessionResumeSupported: true,
          sessionResumeReady: true,
        }),
        closeAcpSession,
        unbindSessionBindings,
      });

      await runTaskRegistryMaintenance();

      expect(closeAcpSession).not.toHaveBeenCalled();
      expect(unbindSessionBindings).not.toHaveBeenCalled();
    });
  });

  it("closes terminal one-shot ACP sessions before resume is confirmed ready", async () => {
    await withTaskRegistryTempDir(async () => {
      const now = Date.now();
      const parentSessionKey = "agent:main:telegram:direct:owner";
      const childSessionKey = "agent:codex:acp:unmaterialized-oneshot";
      const task = createTaskFixture("acp", {
        ownerKey: parentSessionKey,
        requesterSessionKey: parentSessionKey,
        childSessionKey,
        runId: "run-terminal-acp-unmaterialized-oneshot",
        task: "Cancelled before the first prompt",
        status: "cancelled",
        deliveryStatus: "delivered",
        lastEventAt: now - 60_000,
      });
      finalizeTaskRecordByRunId({
        runId: "run-terminal-acp-unmaterialized-oneshot",
        runtime: "acp",
        status: "cancelled",
        endedAt: now - 60_000,
        lastEventAt: now - 60_000,
      });
      const current = getTaskById(task.taskId)!;
      const closeAcpSession = vi.fn().mockResolvedValue(undefined);

      configureTaskRegistryMaintenanceRuntimeForTest({
        currentTasks: new Map([[task.taskId, current]]),
        snapshotTasks: [current],
        acpEntry: createAcpSessionStoreEntry({
          sessionKey: childSessionKey,
          parentSessionKey,
          mode: "oneshot",
          resumeSessionId: "codex-unmaterialized-thread",
          sessionResumeSupported: true,
        }),
        closeAcpSession,
        unbindSessionBindings: vi.fn().mockResolvedValue([]),
      });

      await runTaskRegistryMaintenance();

      expect(closeAcpSession).toHaveBeenCalledWith({
        cfg: {},
        sessionKey: childSessionKey,
        reason: "terminal-task-cleanup",
      });
    });
  });

  it("closes terminal one-shot ACP sessions when the agent cannot resume", async () => {
    await withTaskRegistryTempDir(async () => {
      const now = Date.now();
      const parentSessionKey = "agent:main:telegram:direct:owner";
      const childSessionKey = "agent:claude:acp:non-resumable-oneshot";
      const task = createTaskFixture("acp", {
        ownerKey: parentSessionKey,
        requesterSessionKey: parentSessionKey,
        childSessionKey,
        runId: "run-terminal-acp-non-resumable-oneshot",
        task: "Non-resumable ACP task",
        status: "succeeded",
        deliveryStatus: "delivered",
        lastEventAt: now - 60_000,
      });
      finalizeTaskRecordByRunId({
        runId: "run-terminal-acp-non-resumable-oneshot",
        runtime: "acp",
        status: "succeeded",
        endedAt: now - 60_000,
        lastEventAt: now - 60_000,
      });
      const current = getTaskById(task.taskId)!;
      const closeAcpSession = vi.fn().mockResolvedValue(undefined);

      configureTaskRegistryMaintenanceRuntimeForTest({
        currentTasks: new Map([[task.taskId, current]]),
        snapshotTasks: [current],
        acpEntry: createAcpSessionStoreEntry({
          sessionKey: childSessionKey,
          parentSessionKey,
          mode: "oneshot",
          resumeSessionId: "claude-session-unsupported",
          sessionResumeSupported: false,
        }),
        closeAcpSession,
        unbindSessionBindings: vi.fn().mockResolvedValue([]),
      });

      await runTaskRegistryMaintenance();

      expect(closeAcpSession).toHaveBeenCalledWith({
        cfg: {},
        sessionKey: childSessionKey,
        reason: "terminal-task-cleanup",
      });
    });
  });

  it("keeps orphaned parent-owned one-shot ACP sessions with a stable resume identity", async () => {
    await withTaskRegistryTempDir(async () => {
      const parentSessionKey = "agent:main:telegram:direct:owner";
      const childSessionKey = "agent:claude:acp:orphaned-resumable-oneshot";
      const closeAcpSession = vi.fn().mockResolvedValue(undefined);
      const unbindSessionBindings = vi.fn().mockResolvedValue([]);

      configureTaskRegistryMaintenanceRuntimeForTest({
        currentTasks: new Map(),
        snapshotTasks: [],
        acpEntries: [
          createAcpSessionStoreEntry({
            sessionKey: childSessionKey,
            parentSessionKey,
            mode: "oneshot",
            resumeSessionId: "claude-session-456",
            sessionResumeSupported: true,
            sessionResumeReady: true,
          }),
        ],
        closeAcpSession,
        unbindSessionBindings,
      });

      await runTaskRegistryMaintenance();

      expect(closeAcpSession).not.toHaveBeenCalled();
      expect(unbindSessionBindings).not.toHaveBeenCalled();
    });
  });
});
