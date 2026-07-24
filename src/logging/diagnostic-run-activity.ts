// Diagnostic run activity helpers summarize run lifecycle activity for diagnostics.
import {
  getInternalDiagnosticEventSequence,
  hasPendingInternalDiagnosticOwnerEvent,
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
  type DiagnosticSessionActiveWorkKind,
} from "../infra/diagnostic-events.js";
import {
  deleteDiagnosticActiveRunsStartedBefore,
  deleteRecoveredDiagnosticActiveRuns,
  type DiagnosticActiveRun,
  mergeDiagnosticActiveRuns,
  pruneRecoveredOwnerStartEventCutoffs,
  registerDiagnosticActiveRun,
  rememberRecoveredOwnerStartEventCutoffs,
  shouldIgnoreRecoveredOwnerStartEvent,
  activityMarkerBelongsToOwner,
  activityMarkerStartedAfter,
  recoveryOwnerRefs,
} from "./diagnostic-run-activity-recovery.js";
import { createDiagnosticRunActivityRetention } from "./diagnostic-run-activity-retention.js";
import {
  createDiagnosticSessionActivityRefStore,
  diagnosticModelCallActivityKey,
  diagnosticSessionRefs,
  diagnosticToolActivityKey,
} from "./diagnostic-run-activity-store.js";

type SessionActivity = {
  sessionId?: string;
  sessionKey?: string;
  sessionRefs: Set<string>;
  activeRuns: Map<string, DiagnosticActiveRun>;
  activeReplyOperations: Set<string>;
  activeEmbeddedRuns: Map<string, ActiveEmbeddedRun>;
  activeTools: Map<string, ActiveTool>;
  activeModelCalls: Map<string, ActiveModelCall>;
  recoveredOwnerStartEventCutoffs: Map<string, number>;
  lastProgressAt: number;
  lastProgressReason?: string;
};

type ActiveEmbeddedRun = {
  sessionId?: string;
  sessionKey?: string;
  sequence: number;
};

type ActiveTool = {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  sequence?: number;
  toolName: string;
  toolCallId?: string;
  startedAt: number;
  lastProgressAt: number;
};

type ActiveModelCall = {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  sequence?: number;
};

type DiagnosticToolStartedActivityEvent = Pick<
  Extract<DiagnosticEventPayload, { type: "tool.execution.started" }>,
  "runId" | "sessionId" | "sessionKey" | "toolName" | "toolCallId"
> & { seq?: number };

type DiagnosticModelStartedActivityEvent = Pick<
  Extract<DiagnosticEventPayload, { type: "model.call.started" }>,
  "runId" | "sessionId" | "sessionKey" | "provider" | "model"
> & { seq?: number };

type DiagnosticRunProgressActivityEvent = Pick<
  Extract<DiagnosticEventPayload, { type: "run.progress" }>,
  "runId" | "sessionId" | "sessionKey" | "reason"
> & { seq?: number };

// Quiet-but-alive tools are normal agent behavior; the CLI byte watchdog kills
// truly silent children within its own deadline. This floor bounds every
// staleness consumer (diagnostic recovery aborts, reply-run stale takeover,
// steer gates): lowering it reopens #88870, removing it reopens #96168.
export const BLOCKED_TOOL_CALL_ABORT_FLOOR_MS = 15 * 60_000;

// Default quiet-run reclaim window for steer/takeover. Evidence clocks stay local.
export const RUN_STALE_TAKEOVER_MS = 10 * 60_000;

export type DiagnosticSessionActivitySnapshot = {
  activeWorkKind?: DiagnosticSessionActiveWorkKind;
  hasActiveEmbeddedRun?: boolean;
  activeToolName?: string;
  activeToolCallId?: string;
  activeToolAgeMs?: number;
  lastProgressAgeMs?: number;
  lastProgressReason?: string;
};

// Quiet-but-alive tool phases get the blocked-tool floor so a human message
// cannot reclaim a healthy long tool that stuck recovery would not touch yet.
export function resolveRunStaleThresholdMs(
  activity: Pick<DiagnosticSessionActivitySnapshot, "activeWorkKind">,
): number {
  return activity.activeWorkKind === "tool_call"
    ? Math.max(RUN_STALE_TAKEOVER_MS, BLOCKED_TOOL_CALL_ABORT_FLOOR_MS)
    : RUN_STALE_TAKEOVER_MS;
}

const activityByRef = new Map<string, SessionActivity>();
const activityByRunId = new Map<string, SessionActivity>();
const sessionActivities = new Set<SessionActivity>();
let embeddedRunSequence = 0;
const sessionActivityRefs = createDiagnosticSessionActivityRefStore(
  activityByRef,
  sessionActivities,
);

function registerActiveRun(
  activity: SessionActivity,
  event: { runId?: string; sessionId?: string; seq?: number },
): void {
  const runId = registerDiagnosticActiveRun(activity.activeRuns, event, activity.sessionId);
  if (runId) {
    activityByRunId.set(runId, activity);
  }
}

function replaceSessionActivityReferences(source: SessionActivity, target: SessionActivity): void {
  sessionActivityRefs.replace(source, target);
  for (const [runId, activity] of activityByRunId) {
    if (activity === source) {
      activityByRunId.set(runId, target);
    }
  }
}

function mergeSessionActivity(target: SessionActivity, source: SessionActivity): void {
  target.sessionId ??= source.sessionId;
  target.sessionKey ??= source.sessionKey;
  mergeDiagnosticActiveRuns(target.activeRuns, source.activeRuns);
  for (const replyOperation of source.activeReplyOperations) {
    target.activeReplyOperations.add(replyOperation);
  }
  for (const [key, embeddedRun] of source.activeEmbeddedRuns) {
    target.activeEmbeddedRuns.set(key, embeddedRun);
  }
  for (const [key, tool] of source.activeTools) {
    target.activeTools.set(key, tool);
  }
  for (const [key, modelCall] of source.activeModelCalls) {
    target.activeModelCalls.set(key, modelCall);
  }
  for (const [ownerRef, cutoff] of source.recoveredOwnerStartEventCutoffs) {
    target.recoveredOwnerStartEventCutoffs.set(
      ownerRef,
      Math.max(cutoff, target.recoveredOwnerStartEventCutoffs.get(ownerRef) ?? 0),
    );
  }
  if (source.lastProgressAt > target.lastProgressAt) {
    target.lastProgressAt = source.lastProgressAt;
    target.lastProgressReason = source.lastProgressReason;
  }
  replaceSessionActivityReferences(source, target);
  sessionActivities.delete(source);
  sessionActivityRefs.prune(target);
}

function resolveSessionActivity(params: {
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  create?: boolean;
  trackCurrent?: boolean;
}): SessionActivity | undefined {
  let activity: SessionActivity | undefined;
  if (params.runId) {
    const byRun = activityByRunId.get(params.runId);
    if (byRun) {
      activity = byRun;
    }
  }

  for (const ref of diagnosticSessionRefs(params)) {
    const byRef = activityByRef.get(ref);
    if (!byRef) {
      continue;
    }
    if (!activity) {
      activity = byRef;
    } else if (activity !== byRef) {
      mergeSessionActivity(activity, byRef);
    }
  }

  if (activity) {
    sessionActivityRefs.register(activity, params, params.trackCurrent !== false);
    return activity;
  }

  // Unidentified activity cannot be resolved by terminal events and would be retained forever.
  if (!params.create || (!params.runId?.trim() && diagnosticSessionRefs(params).length === 0)) {
    return undefined;
  }

  const created: SessionActivity = {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionRefs: new Set(),
    activeRuns: new Map(),
    activeReplyOperations: new Set(),
    activeEmbeddedRuns: new Map(),
    activeTools: new Map(),
    activeModelCalls: new Map(),
    recoveredOwnerStartEventCutoffs: new Map(),
    lastProgressAt: Date.now(),
  };
  sessionActivityRefs.register(created, params);
  return created;
}

function isIdleSessionActivity(activity: SessionActivity): boolean {
  // A recovery cutoff owns queued stale events until their indexed drain completes;
  // evicting it early lets those events recreate the retired owner.
  pruneRecoveredOwnerStartEventCutoffs(activity.recoveredOwnerStartEventCutoffs);
  return (
    activity.activeRuns.size === 0 &&
    activity.activeReplyOperations.size === 0 &&
    activity.activeEmbeddedRuns.size === 0 &&
    activity.activeTools.size === 0 &&
    activity.activeModelCalls.size === 0 &&
    activity.recoveredOwnerStartEventCutoffs.size === 0
  );
}

function deleteSessionActivity(activity: SessionActivity): void {
  sessionActivityRefs.delete(activity);
}

const activityRetention = createDiagnosticRunActivityRetention({
  activities: sessionActivities,
  deleteActivity: deleteSessionActivity,
  hasPendingRunEvent: ({ runId, seq }) => hasPendingInternalDiagnosticOwnerEvent(runId, seq, "run"),
  isIdle: isIdleSessionActivity,
  lastProgressAt: (activity) => activity.lastProgressAt,
});

function touchSessionActivity(activity: SessionActivity, reason: string, now = Date.now()): void {
  activity.lastProgressAt = now;
  activity.lastProgressReason = reason;
  pruneRecoveredOwnerStartEventCutoffs(activity.recoveredOwnerStartEventCutoffs);
  sessionActivityRefs.prune(activity);
  activityRetention.prune(now);
}

function recordToolStarted(event: DiagnosticToolStartedActivityEvent): void {
  if (activityRetention.isCompletedRunEvent(event)) {
    return;
  }
  const activity = resolveSessionActivity({ ...event, create: true });
  if (!activity) {
    return;
  }
  if (shouldIgnoreRecoveredOwnerStartEvent(activity.recoveredOwnerStartEventCutoffs, event)) {
    sessionActivityRefs.prune(activity);
    return;
  }
  registerActiveRun(activity, event);
  const now = Date.now();
  activity.activeTools.set(diagnosticToolActivityKey(event), {
    runId: event.runId,
    sessionId: event.sessionId,
    sessionKey: event.sessionKey,
    sequence: event.seq,
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    startedAt: now,
    lastProgressAt: now,
  });
  touchSessionActivity(activity, `tool:${event.toolName}:started`, now);
}

function recordToolEnded(
  event: Extract<
    DiagnosticEventPayload,
    { type: "tool.execution.completed" | "tool.execution.error" | "tool.execution.blocked" }
  >,
): void {
  if (activityRetention.isCompletedRunEvent(event)) {
    return;
  }
  const activity = resolveSessionActivity(event);
  if (!activity) {
    return;
  }
  activity.activeTools.delete(diagnosticToolActivityKey(event));
  touchSessionActivity(activity, `tool:${event.toolName}:ended`);
}

function recordModelStarted(event: DiagnosticModelStartedActivityEvent): void {
  if (activityRetention.isCompletedRunEvent(event)) {
    return;
  }
  const activity = resolveSessionActivity({ ...event, create: true });
  if (!activity) {
    return;
  }
  if (shouldIgnoreRecoveredOwnerStartEvent(activity.recoveredOwnerStartEventCutoffs, event)) {
    sessionActivityRefs.prune(activity);
    return;
  }
  activity.activeModelCalls.set(diagnosticModelCallActivityKey(event), {
    runId: event.runId,
    sessionId: event.sessionId,
    sessionKey: event.sessionKey,
    sequence: event.seq,
  });
  touchSessionActivity(activity, "model_call:started");
}

function recordModelEnded(
  event: Extract<DiagnosticEventPayload, { type: "model.call.completed" | "model.call.error" }>,
): void {
  if (activityRetention.isCompletedRunEvent(event)) {
    return;
  }
  const activity = resolveSessionActivity(event);
  if (!activity) {
    return;
  }
  activity.activeModelCalls.delete(diagnosticModelCallActivityKey(event));
  touchSessionActivity(activity, "model_call:ended");
}

function recordRunProgress(event: DiagnosticRunProgressActivityEvent): void {
  markDiagnosticRunProgress(event);
}

export function markDiagnosticRunProgress(params: DiagnosticRunProgressActivityEvent): void {
  if (activityRetention.isCompletedRunEvent(params)) {
    return;
  }
  const activity = resolveSessionActivity({ ...params, create: true });
  if (!activity) {
    return;
  }
  if (shouldIgnoreRecoveredOwnerStartEvent(activity.recoveredOwnerStartEventCutoffs, params)) {
    sessionActivityRefs.prune(activity);
    return;
  }
  registerActiveRun(activity, params);
  touchSessionActivity(activity, params.reason);
}

export function setDiagnosticReplyOperationActive(params: {
  sessionId: string;
  sessionKey: string;
  active: boolean;
}): void {
  const activity = resolveSessionActivity({ ...params, create: params.active });
  if (!activity) {
    return;
  }
  if (!params.active) {
    activity.activeReplyOperations.delete(params.sessionKey);
    sessionActivityRefs.prune(activity);
    return;
  }
  if (!activity.activeReplyOperations.has(params.sessionKey)) {
    activity.activeReplyOperations.add(params.sessionKey);
    touchSessionActivity(activity, "reply_operation:started");
  }
}

function clearRunOwnedActivityMarkers(activity: SessionActivity, runId: string): void {
  for (const [key, tool] of activity.activeTools) {
    if (tool.runId === runId) {
      activity.activeTools.delete(key);
    }
  }
  for (const [key, modelCall] of activity.activeModelCalls) {
    if (modelCall.runId === runId) {
      activity.activeModelCalls.delete(key);
    }
  }
}

function recordRunCompleted(
  event: Extract<DiagnosticEventPayload, { type: "run.completed" }>,
): void {
  const now = Date.now();
  activityRetention.recordRunCompleted(event, now);
  const activity = resolveSessionActivity(event);
  if (!activity) {
    activityRetention.prune(now);
    return;
  }
  activityByRunId.delete(event.runId);
  activity.activeRuns.delete(event.runId);
  clearRunOwnedActivityMarkers(activity, event.runId);
  if (activity.activeRuns.size === 0) {
    activity.activeTools.clear();
    activity.activeModelCalls.clear();
    activity.activeEmbeddedRuns.clear();
  }
  touchSessionActivity(activity, "run:completed", now);
}

export function markDiagnosticEmbeddedRunStarted(params: {
  sessionId: string;
  sessionKey?: string;
  workKey?: string;
}): void {
  const activity = resolveSessionActivity({ ...params, create: true });
  if (!activity) {
    return;
  }
  activity.activeEmbeddedRuns.set(resolveEmbeddedRunWorkKey(params), {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sequence: ++embeddedRunSequence,
  });
  touchSessionActivity(activity, "embedded_run:started");
}

export function markDiagnosticEmbeddedRunEnded(params: {
  sessionId: string;
  sessionKey?: string;
  workKey?: string;
  clearRunActivity?: boolean;
}): void {
  const activity = resolveSessionActivity(params);
  if (!activity) {
    return;
  }
  activity.activeEmbeddedRuns.delete(resolveEmbeddedRunWorkKey(params));
  if (params.clearRunActivity !== false) {
    activity.activeTools.clear();
    activity.activeModelCalls.clear();
  }
  touchSessionActivity(activity, "embedded_run:ended");
}

function resolveEmbeddedRunWorkKey(params: { sessionId: string; workKey?: string }): string {
  return params.workKey ?? params.sessionId;
}

function clearRecoveredOwnerEmbeddedRuns(
  activity: SessionActivity,
  ownerRefs: Set<string>,
  recoveryStartedAfterSequence: number | undefined,
): void {
  if (ownerRefs.size === 0) {
    return;
  }
  for (const [key, embeddedRun] of activity.activeEmbeddedRuns) {
    if (
      embeddedRun.sessionId !== undefined &&
      ownerRefs.has(embeddedRun.sessionId) &&
      !activityMarkerStartedAfter(embeddedRun, recoveryStartedAfterSequence)
    ) {
      activity.activeEmbeddedRuns.delete(key);
    }
  }
}

function hasEmbeddedRunStartedAfter(
  activity: SessionActivity,
  sequence: number | undefined,
): boolean {
  if (sequence === undefined) {
    return activity.activeEmbeddedRuns.size > 0;
  }
  for (const embeddedRun of activity.activeEmbeddedRuns.values()) {
    if (activityMarkerStartedAfter(embeddedRun, sequence)) {
      return true;
    }
  }
  return false;
}

function clearRecoveredOwnerMarkers(
  activity: SessionActivity,
  ownerRefs: Set<string>,
  recoveryStartedAfterSequence: number | undefined,
): void {
  if (ownerRefs.size === 0) {
    return;
  }
  for (const [key, tool] of activity.activeTools) {
    if (
      activityMarkerBelongsToOwner(tool, ownerRefs) &&
      !activityMarkerStartedAfter(tool, recoveryStartedAfterSequence)
    ) {
      activity.activeTools.delete(key);
    }
  }
  for (const [key, modelCall] of activity.activeModelCalls) {
    if (
      activityMarkerBelongsToOwner(modelCall, ownerRefs) &&
      !activityMarkerStartedAfter(modelCall, recoveryStartedAfterSequence)
    ) {
      activity.activeModelCalls.delete(key);
    }
  }
}

function clearRecoveredOwnerRuns(
  activity: SessionActivity,
  ownerRefs: Set<string>,
  recoveryStartedAfterSequence: number | undefined,
): void {
  if (ownerRefs.size === 0) {
    return;
  }
  deleteRecoveredDiagnosticActiveRuns(
    activity.activeRuns,
    ownerRefs,
    recoveryStartedAfterSequence,
    (runId) => {
      if (activityByRunId.get(runId) === activity) {
        activityByRunId.delete(runId);
      }
    },
  );
}

function pruneActivityStartedBeforeRecoveryCutoff(
  activity: SessionActivity,
  recoveryStartedAfterEmbeddedRunSequence: number | undefined,
  recoveryStartedAfterDiagnosticEventSequence: number | undefined,
): void {
  if (
    recoveryStartedAfterEmbeddedRunSequence === undefined &&
    recoveryStartedAfterDiagnosticEventSequence === undefined
  ) {
    return;
  }
  for (const [key, embeddedRun] of activity.activeEmbeddedRuns) {
    if (!activityMarkerStartedAfter(embeddedRun, recoveryStartedAfterEmbeddedRunSequence)) {
      activity.activeEmbeddedRuns.delete(key);
    }
  }
  for (const [key, tool] of activity.activeTools) {
    if (!activityMarkerStartedAfter(tool, recoveryStartedAfterDiagnosticEventSequence)) {
      activity.activeTools.delete(key);
    }
  }
  for (const [key, modelCall] of activity.activeModelCalls) {
    if (!activityMarkerStartedAfter(modelCall, recoveryStartedAfterDiagnosticEventSequence)) {
      activity.activeModelCalls.delete(key);
    }
  }
  deleteDiagnosticActiveRunsStartedBefore(
    activity.activeRuns,
    recoveryStartedAfterDiagnosticEventSequence,
    (runId) => {
      if (activityByRunId.get(runId) === activity) {
        activityByRunId.delete(runId);
      }
    },
  );
}

// Reconciles a session's terminal embedded-run activity at once. Used when an
// authority (stuck-session recovery) declares the lane idle and the per-run
// markDiagnosticEmbeddedRunEnded may have been bypassed. Clears the embedded-run
// owners AND their tool/model markers, matching the default teardown so the lane
// cannot be left as idle + orphaned tool/model activity (which
// isIdleQueuedRecoverableSessionStall still treats as recoverable).
export function clearDiagnosticEmbeddedRunActivityForSession(params: {
  sessionId?: string;
  sessionKey?: string;
  activeSessionId?: string;
  recoveryStartedAfterEmbeddedRunSequence?: number;
  recoveryStartedAfterDiagnosticEventSequence?: number;
}): { cleared: boolean; blockedByActiveEmbeddedRun: boolean } {
  const shouldCreateCutoffActivity =
    params.recoveryStartedAfterDiagnosticEventSequence !== undefined;
  const activity = resolveSessionActivity({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    runId: params.activeSessionId,
    create: shouldCreateCutoffActivity,
  });
  if (!activity) {
    return { cleared: false, blockedByActiveEmbeddedRun: false };
  }
  if (params.activeSessionId) {
    sessionActivityRefs.register(activity, {
      sessionId: params.activeSessionId,
      sessionKey: params.sessionKey,
    });
  }
  const ownerRefs = recoveryOwnerRefs(params);
  pruneRecoveredOwnerStartEventCutoffs(activity.recoveredOwnerStartEventCutoffs);
  rememberRecoveredOwnerStartEventCutoffs(
    activity.recoveredOwnerStartEventCutoffs,
    ownerRefs,
    params.recoveryStartedAfterDiagnosticEventSequence,
  );
  if (
    activity.activeEmbeddedRuns.size === 0 &&
    activity.activeTools.size === 0 &&
    activity.activeModelCalls.size === 0 &&
    activity.activeRuns.size === 0
  ) {
    return { cleared: false, blockedByActiveEmbeddedRun: false };
  }
  clearRecoveredOwnerEmbeddedRuns(
    activity,
    ownerRefs,
    params.recoveryStartedAfterEmbeddedRunSequence,
  );
  clearRecoveredOwnerMarkers(
    activity,
    ownerRefs,
    params.recoveryStartedAfterDiagnosticEventSequence,
  );
  clearRecoveredOwnerRuns(activity, ownerRefs, params.recoveryStartedAfterDiagnosticEventSequence);
  if (activity.activeEmbeddedRuns.size > 0) {
    if (hasEmbeddedRunStartedAfter(activity, params.recoveryStartedAfterEmbeddedRunSequence)) {
      pruneActivityStartedBeforeRecoveryCutoff(
        activity,
        params.recoveryStartedAfterEmbeddedRunSequence,
        params.recoveryStartedAfterDiagnosticEventSequence,
      );
      touchSessionActivity(activity, "embedded_run:recovery_skipped_active_owner");
      return { cleared: false, blockedByActiveEmbeddedRun: true };
    }
    activity.activeEmbeddedRuns.clear();
  }
  activity.activeTools.clear();
  activity.activeModelCalls.clear();
  touchSessionActivity(activity, "embedded_run:ended");
  return { cleared: true, blockedByActiveEmbeddedRun: false };
}

export function getDiagnosticSessionActivitySnapshot(
  params: { sessionId?: string; sessionKey?: string },
  now = Date.now(),
): DiagnosticSessionActivitySnapshot {
  const activity = resolveSessionActivity({ ...params, trackCurrent: false });
  if (!activity) {
    return {};
  }

  let activeWorkKind: DiagnosticSessionActiveWorkKind | undefined;
  if (activity.activeTools.size > 0) {
    activeWorkKind = "tool_call";
  } else if (activity.activeModelCalls.size > 0) {
    activeWorkKind = "model_call";
  } else if (activity.activeEmbeddedRuns.size > 0) {
    activeWorkKind = "embedded_run";
  }

  let activeTool: ActiveTool | undefined;
  for (const tool of activity.activeTools.values()) {
    if (!activeTool || tool.startedAt < activeTool.startedAt) {
      activeTool = tool;
    }
  }
  return {
    activeWorkKind,
    ...(activity.activeEmbeddedRuns.size > 0 ? { hasActiveEmbeddedRun: true } : {}),
    activeToolName: activeTool?.toolName,
    activeToolCallId: activeTool?.toolCallId,
    activeToolAgeMs: activeTool ? Math.max(0, now - activeTool.startedAt) : undefined,
    lastProgressAgeMs: Math.max(0, now - activity.lastProgressAt),
    lastProgressReason: activity.lastProgressReason,
  };
}

export function getDiagnosticEmbeddedRunActivitySequence(): number {
  return embeddedRunSequence;
}

function markDiagnosticRunProgressForTest(params: DiagnosticRunProgressActivityEvent): void {
  markDiagnosticRunProgress(params);
}

function getRecoveredOwnerCutoffCountForTest(params: {
  sessionId?: string;
  sessionKey?: string;
}): number {
  const activity = resolveSessionActivity({ ...params, trackCurrent: false });
  return activity?.recoveredOwnerStartEventCutoffs.size ?? 0;
}

function markDiagnosticToolStartedForTest(params: {
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
}): void {
  recordToolStarted(params);
}

function markDiagnosticModelStartedForTest(params: DiagnosticModelStartedActivityEvent): void {
  recordModelStarted(params);
}

export function resetDiagnosticRunActivityForTest(): void {
  stopDiagnosticRunActivityTracking();
}

let unregisterDiagnosticRunActivityListener: (() => void) | undefined;

export function startDiagnosticRunActivityTracking(): void {
  if (unregisterDiagnosticRunActivityListener) {
    return;
  }
  const startAfterEventSequence = getInternalDiagnosticEventSequence();
  unregisterDiagnosticRunActivityListener = onInternalDiagnosticEvent((event) => {
    // A prior lifecycle can leave already-sequenced events in the async queue.
    // Ignore them so a restart cannot recreate activity that stop cleared.
    if (event.seq <= startAfterEventSequence) {
      return;
    }
    switch (event.type) {
      case "run.started":
        markDiagnosticRunProgress({ ...event, reason: "run:started" });
        return;
      case "tool.execution.started":
        recordToolStarted(event);
        return;
      case "tool.execution.completed":
      case "tool.execution.error":
      case "tool.execution.blocked":
        recordToolEnded(event);
        return;
      case "model.call.started":
        recordModelStarted(event);
        return;
      case "model.call.completed":
      case "model.call.error":
        recordModelEnded(event);
        return;
      case "run.progress":
        recordRunProgress(event);
        return;
      case "run.completed":
        recordRunCompleted(event);

      default:
    }
  });
}

export function stopDiagnosticRunActivityTracking(): void {
  unregisterDiagnosticRunActivityListener?.();
  unregisterDiagnosticRunActivityListener = undefined;
  activityByRef.clear();
  activityByRunId.clear();
  sessionActivities.clear();
  activityRetention.reset();
  embeddedRunSequence = 0;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.diagnosticRunActivityTestApi")
  ] = {
    getRecoveredOwnerCutoffCountForTest,
    markDiagnosticModelStartedForTest,
    markDiagnosticRunProgressForTest,
    markDiagnosticToolStartedForTest,
  };
}
