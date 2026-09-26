// Reconciles stale or lost task registry records during maintenance passes.
import { isDeepStrictEqual } from "node:util";
import { isAcpTurnActive } from "../acp/control-plane/active-turns.js";
import { resolveAcpSessionTarget } from "../acp/control-plane/manager.utils.js";
import { listAcpSessionEntries, readAcpSessionEntry } from "../acp/runtime/session-meta.js";
import { isBackgroundExecSessionActive } from "../agents/bash-process-control.js";
import {
  formatSubagentRecoveryWedgedReason,
  isSubagentRecoveryWedgedEntry,
} from "../agents/subagents/registry/subagent-recovery-state.js";
import { hasSubagentTaskOwner } from "../agents/subagents/registry/subagent-registry-read.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import {
  readSessionBackingFacts,
  readSessionBackingFactsInWorker,
} from "../config/sessions/session-accessor.js";
import { isCronJobActive } from "../cron/active-jobs.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { sweepExpiredPluginStateEntries } from "../plugin-state/plugin-state-store.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { deriveSessionChatTypeFromKey } from "../sessions/session-chat-type-shared.js";
import { isArtifactPreservingStateRead } from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { isBackgroundExecTask } from "./background-exec-task-contract.js";
import {
  isContextEngineMaintenanceTaskOwnerActive,
  isContextEngineTurnMaintenanceTask,
} from "./context-engine-maintenance-task-owner.js";
import {
  collectCronHistoryOverflowTaskIds,
  shouldPruneTerminalTask,
} from "./cron-history-retention.js";
import {
  getDetachedTaskLifecycleRuntime,
  tryRecoverTaskBeforeMarkLost,
} from "./detached-task-runtime.js";
import { isHarnessOwnedSubagentTask } from "./harness-owned-subagent-task.js";
import {
  ensureTaskRegistryReady,
  getTaskById,
  hasActiveTaskForChildSessionKey,
  listTaskRecords,
  markTaskLostById,
  maybeDeliverTaskTerminalUpdate,
  resolveTaskForLookupToken,
} from "./runtime-internal.js";
import { readTaskBackingInstance } from "./task-backing-authority.js";
import {
  canRecoverCronTask,
  resolveCronTerminalRecovery,
  selectCronRecoveryRow,
  type CronTerminalRecovery,
} from "./task-cron-maintenance-policy.js";
import { runTaskFlowRegistryMaintenance } from "./task-flow-registry.maintenance.js";
import {
  cleanupOrphanedParentOwnedAcpSessions,
  cleanupTerminalAcpSession,
  loadTaskAcpSessionCloser,
  type CloseAcpSession,
  type TaskRegistryAcpMaintenanceRuntime,
} from "./task-registry-acp-cleanup.js";
import { reconcileCronTaskForMaintenance } from "./task-registry-maintenance-cron.js";
import { applyTaskRegistryMaintenanceRetention } from "./task-registry-maintenance-retention.js";
import { createTaskMaintenanceScheduler } from "./task-registry-maintenance-scheduler.js";
import {
  createBackingSessionLookupContext,
  findTaskSessionEntry,
  hasActiveCliRun,
  hasCliRunIdentity,
  prepareBackingSessionFacts,
  observeBackingSessionFacts,
  resolveSessionChatType,
  type BackingSessionLookupContext,
} from "./task-registry-maintenance-session-facts.js";
import {
  getTaskRegistryMaintenanceSnapshot,
  getTaskRegistryMaintenanceTask,
  TASK_MAINTENANCE_BATCH_SIZE,
  visitTaskRegistryMaintenanceTasks,
} from "./task-registry-maintenance-snapshot.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
import { withTaskRegistryMutation } from "./task-registry-state.js";
import {
  configureTaskAuditTaskProvider,
  listTaskAuditFindings,
  summarizeTaskAuditFindings,
} from "./task-registry.audit.js";
import type { TaskAuditFinding, TaskAuditSummary } from "./task-registry.audit.js";
import { listTaskRegistryRecordsByRuntimeSourceIdFromSqlite } from "./task-registry.store.sqlite.js";
import {
  addTaskStatusSummaryRecord,
  createEmptyTaskStatusSummary,
  summarizeTaskRecords,
  type TaskStatusSummary,
} from "./task-registry.summary.js";
import type { TaskRecord, TaskRegistrySummary } from "./task-registry.types.js";
import type { ActiveTaskRestartBlocker } from "./task-restart-blocker.js";
import {
  resolveEffectiveTaskCleanupAfter,
  resolveTaskCleanupAfter,
  shouldStampCleanupAfter,
} from "./task-retention.js";
export { CRON_HISTORY_KEEP_PER_JOB } from "./cron-history-retention.js";

const log = createSubsystemLogger("tasks/task-registry-maintenance");
const TASK_RECONCILE_GRACE_MS = 5 * 60_000;
const HARNESS_OWNED_SUBAGENT_RECONCILE_GRACE_MS = 30 * 60_000;
const TASK_STALE_RUNNING_MS = 30 * 60_000;
const maintenanceScheduler = createTaskMaintenanceScheduler(
  async () => {
    // Flow retention reads linked task activity, so reconcile the task owner first.
    // Reversing this order can preserve phantom active work for another sweep.
    await runTaskRegistryMaintenance();
    await runTaskFlowRegistryMaintenance();
  },
  (error) => log.warn("Task registry maintenance failed", { error }),
);
let configuredRuntimeAuthoritative = false;

const backingSessionRuntime = {
  readSessionBackingFacts,
  readSessionBackingFactsInWorker,
  resolveStorePath: resolveSessionStorePathCore,
  parseAgentSessionKey,
  deriveSessionChatTypeFromKey,
};

export type TaskRegistryMaintenanceSummary = {
  reconciled: number;
  recovered: number;
  cleanupStamped: number;
  pruned: number;
};

export type TaskRegistryMaintenanceTaskDiagnostic = {
  taskId: string;
  runtime: TaskRecord["runtime"];
  status: TaskRecord["status"];
  decision: "retained" | "would_reconcile";
  reason:
    | "acp_runtime_not_authoritative"
    | "active_cli_run"
    | "active_background_exec"
    | "backing_session_missing"
    | "backing_session_present"
    | "cli_runtime_not_authoritative"
    | "cron_runtime_not_authoritative"
    | "lost_grace_pending"
    | "subagent_recovery_wedged"
    | "subagent_owner_missing";
  detail?: string;
  ageMs: number;
  childSessionKey?: string;
  runId?: string;
};

export type TaskRegistryMaintenanceDiagnostics = {
  staleRunningTasks: TaskRegistryMaintenanceTaskDiagnostic[];
};

type CronRecoveryContext = {
  taskRowsByJobId: Map<string, TaskRecord[]>;
  taskRowsByTaskId?: ReadonlyMap<string, TaskRecord>;
};

function createCronRecoveryContext(): CronRecoveryContext {
  return { taskRowsByJobId: new Map<string, TaskRecord[]>() };
}

async function prepareBackingSessionFactsForTasks(
  tasks: readonly TaskRecord[],
  context: BackingSessionLookupContext,
  now: number,
): Promise<void> {
  for (const task of tasks) {
    if (task.runtime !== "subagent" && task.runtime !== "cli") {
      continue;
    }
    shouldMarkLost(task, now, context);
  }
  await prepareBackingSessionFacts(context);
}

function isActiveTask(task: TaskRecord): boolean {
  return task.status === "queued" || task.status === "running";
}

function hasLostGraceExpired(task: TaskRecord, now: number): boolean {
  const referenceAt = task.lastEventAt ?? task.startedAt ?? task.createdAt;
  const graceMs = isHarnessOwnedSubagentTask(task)
    ? HARNESS_OWNED_SUBAGENT_RECONCILE_GRACE_MS
    : TASK_RECONCILE_GRACE_MS;
  return now - referenceAt >= graceMs;
}

function getCronTaskRows(context: CronRecoveryContext, jobId: string): TaskRecord[] {
  const cached = context.taskRowsByJobId.get(jobId);
  if (cached) {
    return cached;
  }
  let rows: TaskRecord[];
  try {
    rows = listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
      runtime: "cron",
      sourceId: jobId,
    });
  } catch {
    rows = [];
  }
  context.taskRowsByJobId.set(jobId, rows);
  return rows;
}

function resolveDurableCronTaskRecovery(
  task: TaskRecord,
  context: CronRecoveryContext,
): CronTerminalRecovery | undefined {
  if (!canRecoverCronTask(task)) {
    return undefined;
  }
  const jobId = task.sourceId?.trim();
  if (!jobId) {
    return undefined;
  }
  if (configuredRuntimeAuthoritative && isCronJobActive(jobId)) {
    return undefined;
  }
  const row = context.taskRowsByTaskId
    ? context.taskRowsByTaskId.get(task.taskId)
    : selectCronRecoveryRow(task, getCronTaskRows(context, jobId));
  return resolveCronTerminalRecovery(task, row);
}

function hasBackingSession(task: TaskRecord, context: BackingSessionLookupContext): boolean {
  const hasProcessLocalLiveness =
    task.runtime === "cron" || task.runtime === "cli" || task.runtime === "acp";
  // Only the Gateway owns these process-local liveness registries. A standalone
  // maintenance process must stay conservative when its local registries are empty.
  if (hasProcessLocalLiveness && !configuredRuntimeAuthoritative) {
    return true;
  }
  if (task.runtime === "cron") {
    const jobId = task.sourceId?.trim();
    return jobId ? isCronJobActive(jobId) : false;
  }

  if (isBackgroundExecTask(task)) {
    const processSessionId = task.sourceId?.trim();
    return Boolean(processSessionId && isBackgroundExecSessionActive(processSessionId));
  }
  if (isContextEngineTurnMaintenanceTask(task)) {
    // Only the authoritative Gateway owns the process-local liveness set.
    return !configuredRuntimeAuthoritative
      ? true
      : isContextEngineMaintenanceTaskOwnerActive(task.taskId);
  }
  if (task.runtime === "cli" && hasActiveCliRun(task)) {
    return true;
  }
  if (task.runtime === "cli" && hasCliRunIdentity(task)) {
    return false;
  }

  const childSessionKey = task.childSessionKey?.trim();
  if (!childSessionKey) {
    return !isHarnessOwnedSubagentTask(task);
  }
  if (task.runtime === "acp") {
    // The persisted entry survives a crash, so only a live in-process turn proves the ACP run is alive.
    return isAcpTurnActive(
      resolveAcpSessionTarget({
        cfg: getRuntimeConfig(),
        sessionKey: childSessionKey,
        agentId: task.agentId,
      }),
    );
  }
  if (task.runtime === "subagent" || task.runtime === "cli") {
    if (task.runtime === "cli") {
      const chatType = resolveSessionChatType(childSessionKey, context);
      if (chatType === "channel" || chatType === "group" || chatType === "direct") {
        return false;
      }
    }
    const registryBackedSubagent =
      task.runtime === "subagent" && readTaskBackingInstance(task.detail)?.runtime === "subagent";
    if (registryBackedSubagent && task.runId && getAgentRunContext(task.runId)) {
      return true;
    }
    const entry = findTaskSessionEntry(task, context);
    if (entry === undefined) {
      return true;
    }
    if (task.runtime === "subagent" && isSubagentRecoveryWedgedEntry(entry)) {
      return false;
    }
    if (registryBackedSubagent) {
      // Only the Gateway can rule out a live owner. A retained session is not
      // that owner; the registry also preserves yielded and recovery obligations.
      const taskRunId = task.runId?.trim();
      if (!taskRunId || !configuredRuntimeAuthoritative) {
        return true;
      }
      try {
        return hasSubagentTaskOwner({
          taskRunId,
          childSessionKey,
          requesterSessionKey: task.ownerKey,
        });
      } catch (error) {
        log.warn("Unable to establish subagent task ownership during maintenance", {
          taskId: task.taskId,
          error,
        });
        return true;
      }
    }
    return entry !== null;
  }

  return true;
}

function resolveTaskLostError(task: TaskRecord, context: BackingSessionLookupContext): string {
  if (isContextEngineTurnMaintenanceTask(task)) {
    return "owning process exited";
  }
  if (isHarnessOwnedSubagentTask(task)) {
    return "Native subagent stopped reporting progress";
  }
  if (task.runtime === "subagent") {
    const entry = findTaskSessionEntry(task, context);
    if (entry && isSubagentRecoveryWedgedEntry(entry)) {
      return formatSubagentRecoveryWedgedReason(entry);
    }
    if (readTaskBackingInstance(task.detail)?.runtime === "subagent") {
      return "subagent run ownership missing";
    }
  }
  return "backing session missing";
}

function shouldMarkLost(
  task: TaskRecord,
  now: number,
  context: BackingSessionLookupContext,
): boolean {
  if (!isActiveTask(task)) {
    return false;
  }
  if (!hasLostGraceExpired(task, now)) {
    return false;
  }
  return !hasBackingSession(task, context);
}

function hasTaskLostDecisionInputChanged(before: TaskRecord, after: TaskRecord): boolean {
  return (
    before.status !== after.status ||
    before.runtime !== after.runtime ||
    before.childSessionKey !== after.childSessionKey ||
    before.sourceId !== after.sourceId ||
    before.runId !== after.runId ||
    before.createdAt !== after.createdAt ||
    before.startedAt !== after.startedAt ||
    before.lastEventAt !== after.lastEventAt ||
    before.ownerKey !== after.ownerKey ||
    !isDeepStrictEqual(before.detail, after.detail)
  );
}

function taskReferenceAt(task: TaskRecord): number {
  return task.lastEventAt ?? task.startedAt ?? task.createdAt;
}

function markTaskLost(
  task: TaskRecord,
  now: number,
  context: BackingSessionLookupContext,
): TaskRecord {
  const lostAt = task.endedAt ?? now;
  const cleanupAfter = resolveEffectiveTaskCleanupAfter({
    ...task,
    status: "lost",
    endedAt: lostAt,
  });
  const updated =
    markTaskLostById({
      taskId: task.taskId,
      endedAt: lostAt,
      lastEventAt: now,
      error: task.error ?? resolveTaskLostError(task, context),
      cleanupAfter,
    }) ?? task;
  void maybeDeliverTaskTerminalUpdate(updated.taskId);
  return updated;
}

function projectTaskRecovered(task: TaskRecord, recovery: CronTerminalRecovery): TaskRecord {
  const projected: TaskRecord = {
    ...task,
    status: recovery.status,
    endedAt: recovery.endedAt,
    lastEventAt: recovery.lastEventAt,
    error: recovery.error,
    ...(recovery.terminalSummary !== undefined
      ? { terminalSummary: recovery.terminalSummary }
      : {}),
    ...(recovery.detail !== undefined ? { detail: recovery.detail } : {}),
  };
  if (recovery.error === undefined) {
    delete projected.error;
  }
  return {
    ...projected,
    ...(typeof projected.cleanupAfter === "number"
      ? {}
      : { cleanupAfter: resolveTaskCleanupAfter(projected) }),
  };
}

function projectTaskLost(
  task: TaskRecord,
  now: number,
  context: BackingSessionLookupContext,
): TaskRecord {
  const projected: TaskRecord = {
    ...task,
    status: "lost",
    endedAt: task.endedAt ?? now,
    lastEventAt: now,
    error: task.error ?? resolveTaskLostError(task, context),
  };
  return {
    ...projected,
    ...(typeof projected.cleanupAfter === "number"
      ? {}
      : { cleanupAfter: resolveTaskCleanupAfter(projected) }),
  };
}

function reconcileTaskRecordForOperatorInspectionWithContexts(
  task: TaskRecord,
  context: CronRecoveryContext,
  backingSessionContext: BackingSessionLookupContext,
  now = Date.now(),
): TaskRecord {
  const cronRecovery = resolveDurableCronTaskRecovery(task, context);
  if (cronRecovery) {
    return projectTaskRecovered(task, cronRecovery);
  }
  if (!shouldMarkLost(task, now, backingSessionContext)) {
    return task;
  }
  return projectTaskLost(task, now, backingSessionContext);
}

function reconcileTaskRecordForOperatorInspection(
  task: TaskRecord,
  context: CronRecoveryContext = createCronRecoveryContext(),
): TaskRecord {
  return reconcileTaskRecordForOperatorInspectionWithContexts(
    task,
    context,
    createBackingSessionLookupContext(backingSessionRuntime),
  );
}

function reconcileTaskRecordsForOperatorInspection(tasks: TaskRecord[]): TaskRecord[] {
  const cronRecoveryContext = createCronRecoveryContext();
  const backingSessionContext = createBackingSessionLookupContext(backingSessionRuntime);
  return tasks.map((task) =>
    reconcileTaskRecordForOperatorInspectionWithContexts(
      task,
      cronRecoveryContext,
      backingSessionContext,
    ),
  );
}

export function reconcileInspectableTasks(): TaskRecord[] {
  ensureTaskRegistryReady();
  return reconcileTaskRecordsForOperatorInspection(listTaskRecords());
}

type TaskStatusInspection = TaskStatusSummary & { state: "ready" | "migration-required" };
const pendingStatusInspections = new Map<string, Promise<TaskStatusInspection>>();

/** Coalesce only overlapping inspections; every settled read is replaced by fresh state. */
export async function getInspectableTaskStatusSummaryReadOnly(): Promise<TaskStatusInspection> {
  const context = captureOpenClawStateWorkerContext();
  const preserveSourceArtifacts = isArtifactPreservingStateRead();
  const key = `${context.admission.identity.key}:${preserveSourceArtifacts}`;
  let pending = pendingStatusInspections.get(key);
  if (!pending) {
    const now = Date.now();
    pending = (async () => {
      const snapshot = await runOpenClawStateWorkerOperation(
        context,
        (scope) =>
          scope.execute({ type: "tasks.statusSummary", input: { now, preserveSourceArtifacts } }),
        { existingOnly: true },
      );
      context.admission.assertCurrent();
      if (!snapshot) {
        return { state: "ready" as const, ...createEmptyTaskStatusSummary() };
      }
      const cron = { ...createCronRecoveryContext(), taskRowsByTaskId: snapshot.cronRecoveryRows };
      const backing = createBackingSessionLookupContext(backingSessionRuntime, true);
      const stopObserving = observeBackingSessionFacts(backing);
      try {
        await prepareBackingSessionFactsForTasks(snapshot.candidates, backing, now);
        context.admission.assertCurrent();
        for (const [index, task] of snapshot.candidates.entries()) {
          if (index > 0 && index % TASK_MAINTENANCE_BATCH_SIZE === 0) {
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            context.admission.assertCurrent();
          }
          const projected = reconcileTaskRecordForOperatorInspectionWithContexts(
            task,
            cron,
            backing,
            now,
          );
          addTaskStatusSummaryRecord(snapshot.summary, projected, now);
        }
        return { state: snapshot.state, ...snapshot.summary };
      } finally {
        stopObserving();
      }
    })();
    pendingStatusInspections.set(key, pending);
    const clear = () => {
      if (pendingStatusInspections.get(key) === pending) {
        pendingStatusInspections.delete(key);
      }
    };
    void pending.then(clear, clear);
  }
  const summary = await pending;
  context.admission.assertCurrent();
  return structuredClone(summary);
}

configureTaskAuditTaskProvider(reconcileInspectableTasks);

function isTaskRestartBlocker(task: TaskRecord): task is TaskRecord & {
  status: ActiveTaskRestartBlocker["status"];
} {
  // A task that is merely queued has not started user work yet; durable queued
  // work can survive a gateway restart and should not indefinitely block one.
  // Likewise, stale records that still say "running" but already have endedAt
  // are registry inconsistencies, not live restart blockers.
  return task.status === "running" && !task.endedAt;
}

export function getInspectableActiveTaskRestartBlockers(): ActiveTaskRestartBlocker[] {
  ensureTaskRegistryReady();
  // Reconciliation can retire a blocker, never revive a non-blocker. Select first
  // so frequent restart polls do not clone and sort retained terminal history.
  const candidates = listTaskRecords(isTaskRestartBlocker);
  const blockers: ActiveTaskRestartBlocker[] = [];
  for (const task of reconcileTaskRecordsForOperatorInspection(candidates)) {
    if (!isTaskRestartBlocker(task)) {
      continue;
    }
    const blocker: ActiveTaskRestartBlocker = {
      taskId: task.taskId,
      status: task.status,
      runtime: task.runtime,
    };
    if (task.taskKind) {
      blocker.taskKind = task.taskKind;
    }
    if (task.runId) {
      blocker.runId = task.runId;
    }
    if (task.label) {
      blocker.label = task.label;
    }
    if (task.task) {
      blocker.title = task.task;
    }
    blockers.push(blocker);
  }
  return blockers;
}

export function getInspectableTaskRegistrySummary(
  tasks: TaskRecord[] = reconcileInspectableTasks(),
): TaskRegistrySummary {
  return summarizeTaskRecords(tasks);
}

export function getInspectableTaskAuditSummary(): TaskAuditSummary {
  return summarizeTaskAuditFindings(getInspectableTaskAuditFindings());
}

export function getInspectableTaskAuditFindings(
  tasks: TaskRecord[] = reconcileInspectableTasks(),
): TaskAuditFinding[] {
  return listTaskAuditFindings({ tasks });
}

export function reconcileTaskLookupToken(token: string): TaskRecord | undefined {
  ensureTaskRegistryReady();
  const task = resolveTaskForLookupToken(token);
  return task ? reconcileTaskRecordForOperatorInspection(task) : undefined;
}

// Preview is synchronous and cannot call the async detached-task recovery hook,
// so hook-recovered tasks are counted under reconciled here. Durable cron
// recovery is synchronous and can be previewed exactly.
export function previewTaskRegistryMaintenance(): TaskRegistryMaintenanceSummary {
  ensureTaskRegistryReady();
  const now = Date.now();
  let reconciled = 0;
  let recovered = 0;
  let cleanupStamped = 0;
  let pruned = 0;
  const cronRecoveryContext = createCronRecoveryContext();
  const backingSessionContext = createBackingSessionLookupContext(backingSessionRuntime);
  const tasks = listTaskRecords();
  const cronHistoryOverflowTaskIds = collectCronHistoryOverflowTaskIds(tasks);
  for (const task of tasks) {
    if (resolveDurableCronTaskRecovery(task, cronRecoveryContext)) {
      recovered += 1;
      continue;
    }
    if (shouldMarkLost(task, now, backingSessionContext)) {
      reconciled += 1;
      continue;
    }
    if (shouldPruneTerminalTask(task, now, cronHistoryOverflowTaskIds)) {
      pruned += 1;
      continue;
    }
    if (shouldStampCleanupAfter(task)) {
      cleanupStamped += 1;
    }
  }
  return { reconciled, recovered, cleanupStamped, pruned };
}

function explainActiveTaskRetention(params: {
  task: TaskRecord;
  now: number;
  context: BackingSessionLookupContext;
}): Pick<TaskRegistryMaintenanceTaskDiagnostic, "decision" | "reason" | "detail"> {
  if (!hasLostGraceExpired(params.task, params.now)) {
    return { decision: "retained", reason: "lost_grace_pending" };
  }
  if (params.task.runtime === "subagent") {
    const entry = findTaskSessionEntry(params.task, params.context);
    if (entry && isSubagentRecoveryWedgedEntry(entry)) {
      return {
        decision: "would_reconcile",
        reason: "subagent_recovery_wedged",
        detail: formatSubagentRecoveryWedgedReason(entry),
      };
    }
  }
  if (!hasBackingSession(params.task, params.context)) {
    return {
      decision: "would_reconcile",
      reason:
        params.task.runtime === "subagent" &&
        readTaskBackingInstance(params.task.detail)?.runtime === "subagent"
          ? "subagent_owner_missing"
          : "backing_session_missing",
    };
  }
  if (params.task.runtime === "cron" && !configuredRuntimeAuthoritative) {
    return { decision: "retained", reason: "cron_runtime_not_authoritative" };
  }
  if (params.task.runtime === "acp" && !configuredRuntimeAuthoritative) {
    return { decision: "retained", reason: "acp_runtime_not_authoritative" };
  }
  if (params.task.runtime === "cli" && !configuredRuntimeAuthoritative) {
    return { decision: "retained", reason: "cli_runtime_not_authoritative" };
  }
  if (params.task.runtime === "cli" && hasActiveCliRun(params.task)) {
    return { decision: "retained", reason: "active_cli_run" };
  }
  if (isBackgroundExecTask(params.task)) {
    return { decision: "retained", reason: "active_background_exec" };
  }
  return { decision: "retained", reason: "backing_session_present" };
}

export function getTaskRegistryMaintenanceDiagnostics(): TaskRegistryMaintenanceDiagnostics {
  ensureTaskRegistryReady();
  const now = Date.now();
  const cronRecoveryContext = createCronRecoveryContext();
  const backingSessionContext = createBackingSessionLookupContext(backingSessionRuntime);
  const staleRunningTasks: TaskRegistryMaintenanceTaskDiagnostic[] = [];
  for (const task of listTaskRecords()) {
    if (task.status !== "running") {
      continue;
    }
    const ageMs = Math.max(0, now - taskReferenceAt(task));
    if (ageMs < TASK_STALE_RUNNING_MS) {
      continue;
    }
    if (resolveDurableCronTaskRecovery(task, cronRecoveryContext)) {
      continue;
    }
    const decision = explainActiveTaskRetention({ task, now, context: backingSessionContext });
    staleRunningTasks.push({
      taskId: task.taskId,
      runtime: task.runtime,
      status: task.status,
      decision: decision.decision,
      reason: decision.reason,
      ageMs,
      ...(decision.detail ? { detail: decision.detail } : {}),
      ...(task.childSessionKey ? { childSessionKey: task.childSessionKey } : {}),
      ...(task.runId ? { runId: task.runId } : {}),
    });
  }
  return { staleRunningTasks };
}

export async function runTaskRegistryMaintenance(): Promise<TaskRegistryMaintenanceSummary> {
  // Load cleanup code before selecting tasks and checking live session ownership.
  let closeAcpSession: CloseAcpSession | undefined;
  try {
    closeAcpSession = await loadTaskAcpSessionCloser();
  } catch (error) {
    log.warn("Failed to load ACP session cleanup during task maintenance", { error });
  }
  const acpRuntime: TaskRegistryAcpMaintenanceRuntime = {
    listAcpSessionEntries,
    readAcpSessionEntry,
    hasActiveTaskForChildSessionKey,
    listSessionBindingsBySession: (sessionKey) =>
      getSessionBindingService().listBySession(sessionKey),
    unbindSessionBindings: (input) => getSessionBindingService().unbind(input),
  };
  let reconciled = 0;
  let recovered = 0;
  let cleanupStamped = 0;
  let pruned = 0;
  const backingSessionContext = createBackingSessionLookupContext(backingSessionRuntime, true);
  const recoveryHookRegistered = Boolean(
    getDetachedTaskLifecycleRuntime().tryRecoverTaskBeforeMarkLost,
  );
  const stopObservingBacking = observeBackingSessionFacts(backingSessionContext);
  try {
    const { read, deferred } = await visitTaskRegistryMaintenanceTasks(
      {
        prepareTaskRegistryRead,
        getTaskRegistryMaintenanceSnapshot,
        getTaskRegistryMaintenanceTask,
      },
      async (selected, now, cronHistoryOverflowSelections, assertOwnerCurrent) => {
        let current = selected;
        const cronOptions = (markLost: boolean) => ({
          markLost,
          runtimeAuthoritative: () => configuredRuntimeAuthoritative,
          assertOwnerCurrent,
        });
        if (canRecoverCronTask(current)) {
          const result = await reconcileCronTaskForMaintenance(current, now, cronOptions(false));
          assertOwnerCurrent();
          if (result.outcome === "recovered") {
            recovered += 1;
            return;
          }
          if (!result.task) {
            return;
          }
          current = result.task;
        }
        if (shouldMarkLost(current, now, backingSessionContext)) {
          const recovery = await tryRecoverTaskBeforeMarkLost({
            taskId: current.taskId,
            runtime: current.runtime,
            task: current,
            now,
          });
          assertOwnerCurrent();
          if (current.runtime === "cron") {
            const result = await reconcileCronTaskForMaintenance(
              current,
              now,
              cronOptions(!recovery.recovered),
            );
            assertOwnerCurrent();
            if (
              result.outcome === "recovered" ||
              (!result.outcome &&
                recovery.recovered &&
                result.task &&
                shouldMarkLost(result.task, now, backingSessionContext))
            ) {
              recovered += 1;
            } else if (result.outcome === "lost") {
              reconciled += 1;
            }
            return;
          }
          const afterRecovery = getTaskById(current.taskId);
          if (!afterRecovery) {
            return;
          }
          const lostContext =
            recoveryHookRegistered || hasTaskLostDecisionInputChanged(current, afterRecovery)
              ? createBackingSessionLookupContext(backingSessionRuntime, true)
              : backingSessionContext;
          lostContext.sessionChatTypesByKey = backingSessionContext.sessionChatTypesByKey;
          const stopObservingLost = observeBackingSessionFacts(lostContext);
          try {
            if (lostContext !== backingSessionContext) {
              await prepareBackingSessionFactsForTasks([afterRecovery], lostContext, now);
            }
            assertOwnerCurrent();
            withTaskRegistryMutation(
              () => {
                const freshAfterHook = getTaskById(current.taskId);
                if (!freshAfterHook) {
                  return;
                }
                // Recovery yields to runtime owners. Recheck persisted backing while
                // retaining writer custody through the decision and lost-task update.
                if (
                  hasTaskLostDecisionInputChanged(afterRecovery, freshAfterHook) ||
                  !shouldMarkLost(freshAfterHook, now, lostContext)
                ) {
                  return;
                }
                if (recovery.recovered) {
                  recovered += 1;
                  return;
                }
                const next = markTaskLost(freshAfterHook, now, lostContext);
                if (next.status === "lost") {
                  reconciled += 1;
                }
              },
              () => undefined,
            );
          } finally {
            stopObservingLost();
          }
          return;
        }
        if (current.runtime === "acp") {
          await cleanupTerminalAcpSession(acpRuntime, current, closeAcpSession, assertOwnerCurrent);
          assertOwnerCurrent();
        }
        if (
          shouldPruneTerminalTask(current, now, cronHistoryOverflowSelections) ||
          shouldStampCleanupAfter(current)
        ) {
          const result = await applyTaskRegistryMaintenanceRetention(
            current,
            now,
            cronHistoryOverflowSelections,
            assertOwnerCurrent,
          );
          if (result === "pruned") {
            pruned += 1;
          } else if (result === "stamped") {
            cleanupStamped += 1;
          }
        }
      },
      (tasks, now) => prepareBackingSessionFactsForTasks(tasks, backingSessionContext, now),
    );
    if (deferred > 0) {
      log.debug("Deferred task maintenance for unsettled mutations", { count: deferred });
    }
    await cleanupOrphanedParentOwnedAcpSessions(
      acpRuntime,
      closeAcpSession,
      read.assertOwnerCurrent,
    );
    try {
      // Task-registry readiness has already opened the shared state database.
      // Sweep plugin TTL rows even when no plugin namespace was opened this process,
      // so expired state from removed accounts is reclaimed after restart.
      await sweepExpiredPluginStateEntries({ assertActive: read.assertOwnerCurrent });
    } catch (error) {
      log.warn("Failed to sweep expired plugin state entries", { error });
    }
    read.assertOwnerCurrent();
    return { reconciled, recovered, cleanupStamped, pruned };
  } finally {
    stopObservingBacking();
  }
}

export function startTaskRegistryMaintenance(scheduler: GatewayScheduler) {
  ensureTaskRegistryReady();
  maintenanceScheduler.start(scheduler);
}

export async function stopTaskRegistryMaintenance(): Promise<void> {
  await maintenanceScheduler.stop();
}

export function configureTaskRegistryMaintenance(options?: {
  runtimeAuthoritative?: boolean;
}): void {
  if (options?.runtimeAuthoritative !== undefined) {
    configuredRuntimeAuthoritative = options.runtimeAuthoritative;
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
