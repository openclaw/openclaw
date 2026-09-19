import type { AcpSessionStoreEntry } from "../acp/runtime/session-meta.js";
import type { SessionEntry } from "../config/sessions.js";
import type { SessionBindingRecord } from "../infra/outbound/session-binding-service.js";
import type { ParsedAgentSessionKey } from "../routing/session-key.js";
import { collectCronHistoryOverflowTaskIds } from "./cron-history-retention.js";
import { setTaskRegistryMaintenanceRuntimeForTests } from "./task-registry.maintenance.js";
import type { TaskRecord } from "./task-registry.types.js";

type TaskRegistryMaintenanceRuntime = Parameters<
  typeof setTaskRegistryMaintenanceRuntimeForTests
>[0];

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
  listSessionEntries?: TaskRegistryMaintenanceRuntime["listSessionEntries"];
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
            cfg: {} as never,
            storePath: "",
            sessionKey: "",
            storeSessionKey: "",
            entry: acpEntry,
            storeReadFailed: false,
          } satisfies AcpSessionStoreEntry)
        : ({
            cfg: {} as never,
            storePath: "",
            sessionKey: "",
            storeSessionKey: "",
            entry: undefined,
            storeReadFailed: false,
          } satisfies AcpSessionStoreEntry),
    listSessionEntries:
      params.listSessionEntries ??
      (() =>
        Object.entries(sessionStore).map(([sessionKey, entry]) => ({
          sessionKey,
          entry,
        }))),
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
    deleteTaskRecordById: (taskId: string) => currentTasks.delete(taskId),
    ensureTaskRegistryReady: () => {},
    getTaskById: (taskId: string) => currentTasks.get(taskId),
    getTaskRegistryMaintenanceTask: (taskId: string) => currentTasks.get(taskId),
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
    setTaskCleanupAfterById: (patch) => {
      const current = currentTasks.get(patch.taskId);
      if (!current) {
        return null;
      }
      const next = { ...current, cleanupAfter: patch.cleanupAfter };
      currentTasks.set(patch.taskId, next);
      return next;
    },
    isRuntimeAuthoritative: () => params.runtimeAuthoritative ?? true,
    listTaskRegistryRecordsByRuntimeSourceIdFromSqlite: ({ sourceId }) =>
      sourceId ? (durableCronTaskRows[sourceId] ?? []) : Object.values(durableCronTaskRows).flat(),
  };

  setTaskRegistryMaintenanceRuntimeForTests(runtime);
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
  loadCloseAcpSession?: Parameters<
    typeof setTaskRegistryMaintenanceRuntimeForTests
  >[0]["loadCloseAcpSession"];
  closeAcpSession?: (params: {
    cfg: AcpSessionStoreEntry["cfg"];
    sessionKey: string;
    agentId?: string;
    reason: string;
  }) => Promise<void>;
  unbindSessionBindings?: (params: {
    targetSessionKey?: string;
    bindingId?: string;
    reason: string;
  }) => Promise<SessionBindingRecord[]>;
  logWarn?: (message: string, meta?: Record<string, unknown>) => void;
}): void {
  const listSnapshotTasks = params.listTaskRecords ?? (() => params.snapshotTasks);
  const emptyAcpEntry = {
    cfg: {} as never,
    storePath: "",
    sessionKey: "",
    storeSessionKey: "",
    entry: undefined,
    storeReadFailed: false,
  } satisfies AcpSessionStoreEntry;
  setTaskRegistryMaintenanceRuntimeForTests({
    listAcpSessionEntries: params.listAcpSessionEntries ?? (async () => params.acpEntries ?? []),
    readAcpSessionEntry: ({ sessionKey }) =>
      params.acpEntry ??
      params.acpEntries?.find(
        (entry) => entry.sessionKey.trim().toLowerCase() === sessionKey.trim().toLowerCase(),
      ) ??
      emptyAcpEntry,
    listSessionBindingsBySession: () => params.sessionBindings ?? [],
    loadCloseAcpSession: params.loadCloseAcpSession ?? (async () => params.closeAcpSession),
    unbindSessionBindings: params.unbindSessionBindings,
    logWarn: params.logWarn,
    listSessionEntries: () => [],
    resolveStorePath: () => "",
    parseAgentSessionKey: () => null as ParsedAgentSessionKey | null,
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
    deleteTaskRecordById: (taskId: string) => params.currentTasks.delete(taskId),
    ensureTaskRegistryReady: () => {},
    getTaskById: (taskId: string) => params.currentTasks.get(taskId),
    getTaskRegistryMaintenanceTask: (taskId: string) => params.currentTasks.get(taskId),
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
    setTaskCleanupAfterById: (patch: { taskId: string; cleanupAfter: number }) => {
      const current = params.currentTasks.get(patch.taskId);
      if (!current) {
        return null;
      }
      const next = {
        ...current,
        cleanupAfter: patch.cleanupAfter,
      };
      params.currentTasks.set(patch.taskId, next);
      return next;
    },
    isRuntimeAuthoritative: () => params.runtimeAuthoritative ?? true,
    listTaskRegistryRecordsByRuntimeSourceIdFromSqlite: () => [],
  });
}
