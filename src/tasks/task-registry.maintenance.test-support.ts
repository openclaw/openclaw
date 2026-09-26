import { vi, type MockInstance } from "vitest";
import * as acpTurns from "../acp/control-plane/active-turns.js";
import type { AcpSessionStoreEntry } from "../acp/runtime/session-meta.js";
import * as backgroundExec from "../agents/bash-process-control.js";
import * as subagents from "../agents/subagents/registry/subagent-registry-read.js";
import type { SessionEntry } from "../config/sessions.js";
import * as cronJobs from "../cron/active-jobs.js";
import * as agentRuns from "../infra/agent-run-registry.js";
import type { SessionBindingRecord } from "../infra/outbound/session-binding-service.js";
import type { ParsedAgentSessionKey } from "../routing/session-key.js";
import { collectCronHistoryOverflowTaskIds } from "./cron-history-retention.js";
import * as taskRegistry from "./runtime-internal.js";
import {
  captureCronTaskMaintenanceSelection,
  prepareCronTaskMaintenance,
} from "./task-cron-maintenance-policy.js";
import * as acpCleanup from "./task-registry-acp-cleanup.js";
import type { TaskRegistryAcpMaintenanceRuntime } from "./task-registry-acp-cleanup.js";
import * as cronMaintenance from "./task-registry-maintenance-cron.js";
import * as retention from "./task-registry-maintenance-retention.js";
import * as backingFacts from "./task-registry-maintenance-session-facts.js";
import type { BackingSessionRuntime } from "./task-registry-maintenance-session-facts.js";
import * as snapshots from "./task-registry-maintenance-snapshot.js";
import type {
  TaskRegistryMaintenanceRead,
  TaskRegistryMaintenanceReader,
} from "./task-registry-maintenance-snapshot.js";
import {
  captureTaskRetentionSelection,
  prepareTaskRetention,
} from "./task-registry-retention.operation.js";
import { configureTaskRegistryMaintenance } from "./task-registry.maintenance.js";
import * as taskStore from "./task-registry.store.sqlite.js";
import type { TaskRecord } from "./task-registry.types.js";

type TaskRegistryMaintenanceRuntime = TaskRegistryAcpMaintenanceRuntime &
  BackingSessionRuntime &
  TaskRegistryMaintenanceReader &
  Pick<
    typeof taskRegistry,
    | "ensureTaskRegistryReady"
    | "getTaskById"
    | "listTaskRecords"
    | "markTaskLostById"
    | "markTaskTerminalById"
    | "maybeDeliverTaskTerminalUpdate"
    | "resolveTaskForLookupToken"
  > & {
    isCronJobActive: typeof cronJobs.isCronJobActive;
    getAgentRunContext: typeof agentRuns.getAgentRunContext;
    hasSubagentTaskOwner?: typeof subagents.hasSubagentTaskOwner;
    isBackgroundExecSessionActive?: typeof backgroundExec.isBackgroundExecSessionActive;
    hasActiveAcpTurn: (sessionKey: string, agentId?: string) => boolean;
    listTaskRegistryRecordsByRuntimeSourceIdFromSqlite: typeof taskStore.listTaskRegistryRecordsByRuntimeSourceIdFromSqlite;
  };

const restorations: Array<() => void> = [];
const visitMaintenanceTasks = snapshots.visitTaskRegistryMaintenanceTasks;
const createBackingContext = backingFacts.createBackingSessionLookupContext;
const cleanupTerminalSession = acpCleanup.cleanupTerminalAcpSession;
const cleanupOrphanedSessions = acpCleanup.cleanupOrphanedParentOwnedAcpSessions;

function replace<T extends (...args: never[]) => unknown>(
  original: T,
  createSpy: () => MockInstance<T>,
  implementation: Parameters<MockInstance<T>["mockImplementation"]>[0],
) {
  if (Object.is(original, implementation)) {
    return;
  }
  const alreadyMocked = vi.isMockFunction(original);
  const spy = createSpy();
  const previous = spy.getMockImplementation();
  spy.mockImplementation(implementation);
  restorations.push(() => {
    if (!alreadyMocked) {
      spy.mockRestore();
    } else if (previous) {
      spy.mockImplementation(previous);
    } else {
      spy.mockReset();
    }
  });
}

export function resetTaskRegistryMaintenanceMocks() {
  for (const restore of restorations.splice(0).toReversed()) {
    restore();
  }
  configureTaskRegistryMaintenance({ runtimeAuthoritative: false });
}

function installMaintenanceRuntime(
  runtime: TaskRegistryMaintenanceRuntime,
  currentTasks: Map<string, TaskRecord>,
  authoritative: boolean,
) {
  resetTaskRegistryMaintenanceMocks();
  configureTaskRegistryMaintenance({ runtimeAuthoritative: authoritative });
  replace(
    cronMaintenance.reconcileCronTaskForMaintenance,
    () => vi.spyOn(cronMaintenance, "reconcileCronTaskForMaintenance"),
    async (selected, now, options) => {
      options.assertOwnerCurrent();
      const task = currentTasks.get(selected.taskId);
      const jobId = task?.sourceId?.trim();
      if (!task || (options.runtimeAuthoritative() && jobId && runtime.isCronJobActive(jobId))) {
        return { task };
      }
      const rows = jobId
        ? runtime.listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
            runtime: "cron",
            sourceId: jobId,
          })
        : [];
      const result = prepareCronTaskMaintenance(task, rows, {
        taskId: selected.taskId,
        selected: captureCronTaskMaintenanceSelection(selected),
        now,
        markLost: options.markLost,
      });
      if (result) {
        currentTasks.set(task.taskId, result.task);
      }
      return {
        task: result?.task ?? task,
        ...(result && result.task.status !== selected.status
          ? { outcome: result.task.status === "lost" ? ("lost" as const) : ("recovered" as const) }
          : {}),
      };
    },
  );
  replace(
    cronJobs.isCronJobActive,
    () => vi.spyOn(cronJobs, "isCronJobActive"),
    runtime.isCronJobActive,
  );
  replace(
    agentRuns.getAgentRunContext,
    () => vi.spyOn(agentRuns, "getAgentRunContext"),
    runtime.getAgentRunContext,
  );
  replace(
    backgroundExec.isBackgroundExecSessionActive,
    () => vi.spyOn(backgroundExec, "isBackgroundExecSessionActive"),
    runtime.isBackgroundExecSessionActive ?? (() => false),
  );
  replace(
    subagents.hasSubagentTaskOwner,
    () => vi.spyOn(subagents, "hasSubagentTaskOwner"),
    runtime.hasSubagentTaskOwner ?? (() => true),
  );
  replace(
    taskStore.listTaskRegistryRecordsByRuntimeSourceIdFromSqlite,
    () => vi.spyOn(taskStore, "listTaskRegistryRecordsByRuntimeSourceIdFromSqlite"),
    runtime.listTaskRegistryRecordsByRuntimeSourceIdFromSqlite,
  );
  replace(
    taskRegistry.ensureTaskRegistryReady,
    () => vi.spyOn(taskRegistry, "ensureTaskRegistryReady"),
    runtime.ensureTaskRegistryReady,
  );
  replace(
    taskRegistry.getTaskById,
    () => vi.spyOn(taskRegistry, "getTaskById"),
    runtime.getTaskById,
  );
  replace(
    taskRegistry.listTaskRecords,
    () => vi.spyOn(taskRegistry, "listTaskRecords"),
    runtime.listTaskRecords,
  );
  replace(
    taskRegistry.markTaskLostById,
    () => vi.spyOn(taskRegistry, "markTaskLostById"),
    runtime.markTaskLostById,
  );
  replace(
    taskRegistry.markTaskTerminalById,
    () => vi.spyOn(taskRegistry, "markTaskTerminalById"),
    runtime.markTaskTerminalById,
  );
  replace(
    taskRegistry.maybeDeliverTaskTerminalUpdate,
    () => vi.spyOn(taskRegistry, "maybeDeliverTaskTerminalUpdate"),
    runtime.maybeDeliverTaskTerminalUpdate,
  );
  replace(
    taskRegistry.resolveTaskForLookupToken,
    () => vi.spyOn(taskRegistry, "resolveTaskForLookupToken"),
    runtime.resolveTaskForLookupToken,
  );
  replace(
    retention.applyTaskRegistryMaintenanceRetention,
    () => vi.spyOn(retention, "applyTaskRegistryMaintenanceRetention"),
    async (selected, now, cronHistoryOverflowTaskIds, assertOwnerCurrent) => {
      assertOwnerCurrent();
      // Keep retention decisions production-owned while these fixtures use an in-memory ledger.
      const result = prepareTaskRetention(currentTasks.get(selected.taskId), {
        taskId: selected.taskId,
        selection: captureTaskRetentionSelection(selected),
        now,
        cronHistoryOverflow: cronHistoryOverflowTaskIds.has(selected.taskId),
      });
      if (result.kind === "pruned") {
        currentTasks.delete(selected.taskId);
        return "pruned";
      }
      if (result.kind === "stamped") {
        currentTasks.set(selected.taskId, result.task);
        return "stamped";
      }
      return undefined;
    },
  );
  replace(
    acpTurns.isAcpTurnActive,
    () => vi.spyOn(acpTurns, "isAcpTurnActive"),
    (target) => runtime.hasActiveAcpTurn(target.sessionKey, target.agentId),
  );
  replace(
    backingFacts.createBackingSessionLookupContext,
    () => vi.spyOn(backingFacts, "createBackingSessionLookupContext"),
    (_runtime, workerOnly) => createBackingContext(runtime, workerOnly),
  );
  replace(
    snapshots.visitTaskRegistryMaintenanceTasks,
    () => vi.spyOn(snapshots, "visitTaskRegistryMaintenanceTasks"),
    (_source, ...args) => visitMaintenanceTasks(runtime, ...args),
  );
  replace(
    acpCleanup.loadTaskAcpSessionCloser,
    () => vi.spyOn(acpCleanup, "loadTaskAcpSessionCloser"),
    async () => {
      const closer = await runtime.loadCloseAcpSession?.();
      if (!closer) {
        throw new Error("ACP session closer is unavailable in this maintenance fixture");
      }
      return closer;
    },
  );
  replace(
    acpCleanup.cleanupTerminalAcpSession,
    () => vi.spyOn(acpCleanup, "cleanupTerminalAcpSession"),
    (_runtime, task, closer, assertOwnerCurrent) =>
      cleanupTerminalSession(runtime, task, closer, assertOwnerCurrent),
  );
  replace(
    acpCleanup.cleanupOrphanedParentOwnedAcpSessions,
    () => vi.spyOn(acpCleanup, "cleanupOrphanedParentOwnedAcpSessions"),
    (_runtime, closer, assertOwnerCurrent) =>
      cleanupOrphanedSessions(runtime, closer, assertOwnerCurrent),
  );
}

function createPreparedMaintenanceRead(): TaskRegistryMaintenanceRead {
  return {
    assertOwnerCurrent() {},
    assertCurrent() {},
  };
}

export function createAcpSessionStoreEntry(params: {
  sessionKey: string;
  parentSessionKey: string;
  mode: "persistent" | "oneshot";
}): AcpSessionStoreEntry {
  const acp = {
    backend: "acpx",
    agent: "claude",
    runtimeSessionName: `${params.sessionKey}:runtime`,
    mode: params.mode,
    state: "idle",
    lastActivityAt: Date.now(),
  } as const;
  return {
    cfg: {},
    storePath: "/tmp/openclaw-test-sessions.json",
    sessionKey: params.sessionKey,
    storeSessionKey: params.sessionKey,
    entry: {
      sessionId: `${params.sessionKey}:session`,
      updatedAt: Date.now(),
      spawnedBy: params.parentSessionKey,
      acp,
    },
    acp,
    storeReadFailed: false,
  };
}

export function createTaskRegistryMaintenanceHarness(params: {
  tasks: TaskRecord[];
  sessionStore?: Record<string, SessionEntry>;
  readSessionBackingFacts?: TaskRegistryMaintenanceRuntime["readSessionBackingFacts"];
  readSessionBackingFactsInWorker?: TaskRegistryMaintenanceRuntime["readSessionBackingFactsInWorker"];
  resolveStorePath?: TaskRegistryMaintenanceRuntime["resolveStorePath"];
  deriveSessionChatTypeFromKey?: TaskRegistryMaintenanceRuntime["deriveSessionChatTypeFromKey"];
  acpEntry?: AcpSessionStoreEntry["entry"];
  activeCronJobIds?: string[];
  activeRunIds?: string[];
  activeAcpSessionKeys?: string[];
  hasActiveAcpTurn?: TaskRegistryMaintenanceRuntime["hasActiveAcpTurn"];
  durableCronTaskRows?: Record<string, TaskRecord[]>;
  runtimeAuthoritative?: boolean;
  hasSubagentTaskOwner?: TaskRegistryMaintenanceRuntime["hasSubagentTaskOwner"];
}) {
  const sessionStore = params.sessionStore ?? {};
  const acpEntry = params.acpEntry;
  const activeCronJobIds = new Set(params.activeCronJobIds ?? []);
  const activeRunIds = new Set(params.activeRunIds ?? []);
  const activeAcpSessionKeys = new Set(params.activeAcpSessionKeys ?? []);
  const durableCronTaskRows = params.durableCronTaskRows ?? {};
  const currentTasks = new Map(params.tasks.map((task) => [task.taskId, { ...task }]));

  const runtime: TaskRegistryMaintenanceRuntime = {
    listAcpSessionEntries: async () => [],
    readAcpSessionEntry: () =>
      acpEntry !== undefined
        ? ({
            cfg: {},
            storePath: "",
            sessionKey: "",
            storeSessionKey: "",
            entry: acpEntry,
            storeReadFailed: false,
          } satisfies AcpSessionStoreEntry)
        : ({
            cfg: {},
            storePath: "",
            sessionKey: "",
            storeSessionKey: "",
            entry: undefined,
            storeReadFailed: false,
          } satisfies AcpSessionStoreEntry),
    readSessionBackingFacts:
      params.readSessionBackingFacts ??
      ((scope) =>
        scope.sessionKeys.flatMap((sessionKey) =>
          sessionStore[sessionKey] ? [{ sessionKey, entry: sessionStore[sessionKey] }] : [],
        )),
    readSessionBackingFactsInWorker:
      params.readSessionBackingFactsInWorker ??
      (async (scopes) => scopes.map((scope) => runtime.readSessionBackingFacts(scope))),
    resolveStorePath: params.resolveStorePath ?? (() => ""),
    ...(params.deriveSessionChatTypeFromKey
      ? { deriveSessionChatTypeFromKey: params.deriveSessionChatTypeFromKey }
      : {}),
    isCronJobActive: (jobId: string) => activeCronJobIds.has(jobId),
    getAgentRunContext: (runId: string) =>
      activeRunIds.has(runId) ? { sessionKey: "main" } : undefined,
    hasActiveAcpTurn:
      params.hasActiveAcpTurn ?? ((sessionKey: string) => activeAcpSessionKeys.has(sessionKey)),
    hasSubagentTaskOwner: params.hasSubagentTaskOwner,
    parseAgentSessionKey: (sessionKey: string | null | undefined): ParsedAgentSessionKey | null => {
      if (!sessionKey) {
        return null;
      }
      const [kind, agentId, ...rest] = sessionKey.split(":");
      return kind === "agent" && agentId && rest.length > 0
        ? { agentId, rest: rest.join(":") }
        : null;
    },
    hasActiveTaskForChildSessionKey: ({ sessionKey, excludeTaskId }) => {
      const normalized = sessionKey.trim().toLowerCase();
      return Array.from(currentTasks.values()).some(
        (task) =>
          task.taskId !== excludeTaskId &&
          (task.status === "queued" || task.status === "running") &&
          task.childSessionKey?.trim().toLowerCase() === normalized,
      );
    },
    ensureTaskRegistryReady: () => {},
    getTaskById: (taskId: string) => currentTasks.get(taskId),
    getTaskRegistryMaintenanceTask: (taskId: string) => currentTasks.get(taskId),
    prepareTaskRegistryRead: async () => createPreparedMaintenanceRead(),
    listTaskRecords: () => Array.from(currentTasks.values()),
    getTaskRegistryMaintenanceSnapshot: () => {
      const snapshotTasks = Array.from(currentTasks.values());
      return {
        taskIds: snapshotTasks.map((task) => task.taskId),
        cronHistoryOverflowTaskIds: collectCronHistoryOverflowTaskIds(snapshotTasks),
      };
    },
    markTaskLostById: (patch) => {
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
    markTaskTerminalById: (patch) => {
      const current = currentTasks.get(patch.taskId);
      if (!current) {
        return null;
      }
      const next = {
        ...current,
        status: patch.status,
        endedAt: patch.endedAt,
        lastEventAt: patch.lastEventAt ?? patch.endedAt,
        ...(patch.terminalSummary !== undefined
          ? {
              terminalSummary: patch.preserveTerminalSummary
                ? (patch.terminalSummary ?? undefined)
                : patch.terminalSummary?.replace(/\s+/g, " ").trim() || undefined,
            }
          : {}),
        ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
      } satisfies TaskRecord;
      if (Object.hasOwn(patch, "error")) {
        if (patch.error === undefined) {
          delete next.error;
        } else {
          next.error = patch.error;
        }
      }
      currentTasks.set(patch.taskId, next);
      return next;
    },
    maybeDeliverTaskTerminalUpdate: async () => null,
    resolveTaskForLookupToken: () => undefined,
    listTaskRegistryRecordsByRuntimeSourceIdFromSqlite: ({ sourceId }) =>
      sourceId ? (durableCronTaskRows[sourceId] ?? []) : Object.values(durableCronTaskRows).flat(),
  };

  installMaintenanceRuntime(runtime, currentTasks, params.runtimeAuthoritative ?? true);
  return { currentTasks };
}

export function configureTaskRegistryMaintenanceRuntimeForTest(params: {
  currentTasks: Map<string, TaskRecord>;
  snapshotTasks: TaskRecord[];
  listTaskRecords?: () => TaskRecord[];
  acpEntry?: AcpSessionStoreEntry;
  acpEntries?: AcpSessionStoreEntry[];
  listAcpSessionEntries?: () => Promise<AcpSessionStoreEntry[]>;
  hasActiveAcpTurn?: (sessionKey: string) => boolean;
  isBackgroundExecSessionActive?: (sessionId: string) => boolean;
  runtimeAuthoritative?: boolean;
  sessionBindings?: SessionBindingRecord[];
  loadCloseAcpSession?: TaskRegistryMaintenanceRuntime["loadCloseAcpSession"];
  closeAcpSession?: (params: {
    cfg: AcpSessionStoreEntry["cfg"];
    sessionKey: string;
    reason: string;
  }) => Promise<void>;
  unbindSessionBindings?: (params: {
    targetSessionKey?: string;
    bindingId?: string;
    reason: string;
  }) => Promise<SessionBindingRecord[]>;
}): void {
  const listSnapshotTasks = params.listTaskRecords ?? (() => params.snapshotTasks);
  const emptyAcpEntry = {
    cfg: {},
    storePath: "",
    sessionKey: "",
    storeSessionKey: "",
    entry: undefined,
    storeReadFailed: false,
  } satisfies AcpSessionStoreEntry;
  installMaintenanceRuntime(
    {
      listAcpSessionEntries: params.listAcpSessionEntries ?? (async () => params.acpEntries ?? []),
      readAcpSessionEntry: () => params.acpEntry ?? emptyAcpEntry,
      listSessionBindingsBySession: () => params.sessionBindings ?? [],
      loadCloseAcpSession: params.loadCloseAcpSession ?? (async () => params.closeAcpSession),
      unbindSessionBindings: params.unbindSessionBindings,
      readSessionBackingFacts: () => [],
      readSessionBackingFactsInWorker: async (scopes) => scopes.map(() => []),
      resolveStorePath: () => "",
      parseAgentSessionKey: () => null,
      isCronJobActive: () => false,
      getAgentRunContext: () => undefined,
      isBackgroundExecSessionActive: params.isBackgroundExecSessionActive,
      hasActiveAcpTurn: params.hasActiveAcpTurn ?? (() => false),
      hasActiveTaskForChildSessionKey: ({ sessionKey, excludeTaskId }) => {
        const normalized = sessionKey.trim().toLowerCase();
        return Array.from(params.currentTasks.values()).some(
          (task) =>
            task.taskId !== excludeTaskId &&
            (task.status === "queued" || task.status === "running") &&
            task.childSessionKey?.trim().toLowerCase() === normalized,
        );
      },
      ensureTaskRegistryReady: () => {},
      getTaskById: (taskId: string) => params.currentTasks.get(taskId),
      getTaskRegistryMaintenanceTask: (taskId: string) => params.currentTasks.get(taskId),
      prepareTaskRegistryRead: async () => createPreparedMaintenanceRead(),
      listTaskRecords: listSnapshotTasks,
      getTaskRegistryMaintenanceSnapshot: () => {
        const snapshotTasks = listSnapshotTasks();
        return {
          taskIds: snapshotTasks.map((task) => task.taskId),
          cronHistoryOverflowTaskIds: collectCronHistoryOverflowTaskIds(snapshotTasks),
        };
      },
      markTaskLostById: (patch: {
        taskId: string;
        endedAt: number;
        lastEventAt?: number;
        error?: string;
        cleanupAfter?: number;
      }) => {
        const current = params.currentTasks.get(patch.taskId);
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
        params.currentTasks.set(patch.taskId, next);
        return next;
      },
      markTaskTerminalById: () => null,
      maybeDeliverTaskTerminalUpdate: async () => null,
      resolveTaskForLookupToken: () => undefined,
      listTaskRegistryRecordsByRuntimeSourceIdFromSqlite: () => [],
    },
    params.currentTasks,
    params.runtimeAuthoritative ?? true,
  );
}
