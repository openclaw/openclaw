import type { AcpSessionStoreEntry } from "../acp/runtime/session-meta.js";
import type { SessionEntry } from "../config/sessions.js";
import type { ParsedAgentSessionKey } from "../routing/session-key.js";
import { collectCronHistoryOverflowTaskIds } from "./cron-history-retention.js";
import { setTaskRegistryMaintenanceRuntimeForTests } from "./task-registry.maintenance.js";
import type { TaskRecord } from "./task-registry.types.js";

type TaskRegistryMaintenanceRuntime = Parameters<
  typeof setTaskRegistryMaintenanceRuntimeForTests
>[0];

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
    hasActiveAcpTurn: (sessionKey: string) => activeAcpSessionKeys.has(sessionKey),
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
