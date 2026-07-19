import type { DurableRuntimeHealthSnapshot } from "./health.js";
import type {
  DeliveryAttemptEvidence,
  DurableRecoveryState,
  DurableRuntimeEvent,
  DurableRuntimeLink,
  DurableRuntimeLinkStatus,
  DurableRuntimeRef,
  DurableRuntimeRun,
  DurableRuntimeRunStatus,
  DurableRuntimeSignal,
  DurableRuntimeStep,
  DurableRuntimeTimer,
  DurableRuntimeStoreStats,
  DurableUnresolvedObligation,
  UncertaintyFact,
  WakeObligation,
  WakeObligationInspection,
  WakeObligationOwnerKind,
  WakeObligationTargetKind,
  WakeObligationTargetResolutionStatus,
} from "./types.js";

const MAX_PUBLIC_REFS = 100;
const MAX_PUBLIC_TEXT = 2_000;
const MAX_SAFE_ACTIONS = 16;

export type DurableCoordinationWaitingReason =
  | "signal"
  | "timer"
  | "child"
  | "retry"
  | "worker"
  | "unknown";

export type DurableCoordinationChildCounts = {
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  lost: number;
  terminal: number;
  open: number;
};

export type DurableCoordinationRecoveryDiagnostic = {
  state: "lost" | "requires_owner_decision" | "unknown_after_side_effect";
  severity: "warning" | "error";
  reportable: boolean;
  retryable: boolean;
  reason?: string;
  message: string;
  nextAction: string;
  safeRecoveryActions?: string[];
  input?: {
    inputRef?: string;
    inputAvailability?: string;
    canReplay?: boolean;
    reason?: string;
    messageLength?: number;
    messageHash?: string;
  };
  detectedAt?: number;
};

export type DurableCoordinationProjection = {
  runtimeRunId: string;
  operationKind: string;
  operationVersion: string;
  status: DurableRuntimeRunStatus;
  recoveryState: DurableRecoveryState;
  sourceOwner?: string;
  sourceRef?: string;
  parentRuntimeRunId?: string;
  parentStepId?: string;
  workUnitId?: string;
  reportRouteId?: string;
  currentStepId?: string;
  waitingReason?: DurableCoordinationWaitingReason;
  heartbeatAt?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  refs: {
    inputRef?: string;
    checkpointRef?: string;
    outputRefs: string[];
    errorRefs: string[];
    artifactRefs: string[];
  };
  external: {
    taskId?: string;
    taskFlowId?: string;
    sessionKey?: string;
    childSessionKey?: string;
    runId?: string;
    agentId?: string;
    requesterAgentId?: string;
  };
  children: DurableCoordinationChildCounts;
  recovery?: DurableCoordinationRecoveryDiagnostic;
};

export type DurableRunSummary = Omit<DurableCoordinationProjection, "refs" | "external">;

export type DurableStepSummary = Pick<
  DurableRuntimeStep,
  | "runtimeRunId"
  | "stepId"
  | "parentStepId"
  | "stepType"
  | "status"
  | "recoveryState"
  | "attempt"
  | "maxAttempts"
  | "inputRef"
  | "outputRef"
  | "errorRef"
  | "checkpointRef"
  | "claimExpiresAt"
  | "heartbeatAt"
  | "createdAt"
  | "startedAt"
  | "updatedAt"
  | "completedAt"
>;

export type DurableEventSummary = Pick<
  DurableRuntimeEvent,
  | "eventId"
  | "runtimeRunId"
  | "eventSeq"
  | "eventType"
  | "eventTime"
  | "stepId"
  | "agentInvocationId"
  | "toolInvocationId"
  | "checkpointRef"
  | "causationEventId"
  | "correlationId"
  | "recordedAt"
>;

export type DurableLinkSummary = Pick<
  DurableRuntimeLink,
  | "parentRuntimeRunId"
  | "parentStepId"
  | "childRuntimeRunId"
  | "linkType"
  | "status"
  | "createdAt"
  | "updatedAt"
>;
export type DurableSignalSummary = Pick<
  DurableRuntimeSignal,
  | "signalId"
  | "runtimeRunId"
  | "stepId"
  | "signalType"
  | "payloadRef"
  | "correlationId"
  | "receivedAt"
  | "consumedAt"
>;
export type DurableTimerSummary = Pick<
  DurableRuntimeTimer,
  | "timerId"
  | "runtimeRunId"
  | "stepId"
  | "timerType"
  | "dueAt"
  | "status"
  | "createdAt"
  | "firedAt"
  | "cancelledAt"
>;
export type DurableRefSummary = Pick<
  DurableRuntimeRef,
  | "refId"
  | "runtimeRunId"
  | "stepId"
  | "refKind"
  | "mediaType"
  | "hash"
  | "storageKind"
  | "createdAt"
>;
export type DurableObligationSummary = Pick<
  DurableUnresolvedObligation,
  | "obligationId"
  | "sourceOwner"
  | "sourceRef"
  | "kind"
  | "runtimeRunId"
  | "stepId"
  | "wakeId"
  | "uncertaintyFactId"
  | "reason"
  | "status"
  | "createdAt"
  | "updatedAt"
>;

export type DurableWakeSummary = Pick<
  WakeObligation,
  | "wakeId"
  | "sourceOwner"
  | "sourceRef"
  | "parentRunId"
  | "targetKind"
  | "targetRef"
  | "ownerKind"
  | "ownerRef"
  | "reportRouteRef"
  | "targetResolutionStatus"
  | "targetResolutionReason"
  | "reason"
  | "factsRef"
  | "sourceRunId"
  | "attemptCount"
  | "lastAttemptAt"
  | "ackedAt"
  | "failedReason"
  | "status"
  | "createdAt"
  | "updatedAt"
>;

export type DurableUncertaintySummary = Pick<
  UncertaintyFact,
  | "factId"
  | "sourceOwner"
  | "sourceRef"
  | "kind"
  | "sourceRunId"
  | "stepId"
  | "eventId"
  | "refId"
  | "factsRef"
  | "status"
  | "resolutionKind"
  | "resolutionRef"
  | "resolvedAt"
  | "createdAt"
  | "updatedAt"
>;

export type DurableDeliveryAttemptSummary = Pick<
  DeliveryAttemptEvidence,
  | "deliveryAttemptId"
  | "sourceOwner"
  | "sourceRef"
  | "wakeId"
  | "targetKind"
  | "targetRef"
  | "routeKind"
  | "routeRef"
  | "status"
  | "error"
  | "scheduledAt"
  | "attemptedAt"
  | "handoffAcceptedAt"
  | "failedAt"
  | "unknownAt"
  | "createdAt"
  | "updatedAt"
>;

export type DurableWakeInspectionSummary = {
  wake: DurableWakeSummary;
  targetResolution: {
    status?: WakeObligationTargetResolutionStatus;
    reason?: string;
    targetKind?: WakeObligationTargetKind;
    targetRef?: string;
    ownerKind?: WakeObligationOwnerKind;
    ownerRef?: string;
    reportRouteRef?: string;
    factsRef?: string;
    sourceRunId?: string;
  };
  deliveryAttempts: DurableDeliveryAttemptSummary[];
  unresolvedUncertainty: DurableUncertaintySummary[];
  source: {
    sourceOwner: string;
    sourceRef: string;
    factsRef?: string;
    sourceRunId?: string;
    parentRunId?: string;
  };
};

export type DurableRunInspection = {
  run: DurableRunSummary;
  coordination: DurableCoordinationProjection;
  steps: DurableStepSummary[];
  children: DurableLinkSummary[];
  parents: DurableLinkSummary[];
  signals: DurableSignalSummary[];
  refs: DurableRefSummary[];
  timers: DurableTimerSummary[];
  timeline: DurableEventSummary[];
};

export type DurablePublicStoreStats = Pick<
  DurableRuntimeStoreStats,
  "runs" | "events" | "steps" | "openRuns" | "pendingWakes" | "unresolvedUncertaintyFacts"
>;
export type DurablePublicHealthSnapshot = {
  status: DurableRuntimeHealthSnapshot["status"];
  lastSuccessAt?: number;
  lastFailure?: {
    component: NonNullable<DurableRuntimeHealthSnapshot["lastFailure"]>["component"];
    operation: string;
    message: string;
    failedAt: number;
    failureCount: number;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength = MAX_PUBLIC_TEXT): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function publicDiagnosticText(value: unknown, maxLength = MAX_PUBLIC_TEXT): string | undefined {
  return boundedString(value, maxLength)
    ?.replace(/(?:https?|wss?):\/\/\S+/gi, "[endpoint]")
    .replace(/(?:[A-Za-z]:[\\/]|\/)\S+/g, "[path]");
}

function requiredPublicDiagnosticText(value: string): string {
  return publicDiagnosticText(value) ?? "[unavailable]";
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = boundedString(value);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  return values.find((value): value is boolean => typeof value === "boolean");
}

function firstNumber(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result = value
    .map((item) => publicDiagnosticText(item, 200))
    .filter((item): item is string => Boolean(item))
    .slice(0, MAX_SAFE_ACTIONS);
  return result.length > 0 ? result : undefined;
}

function latestStep(steps: readonly DurableRuntimeStep[]): DurableRuntimeStep | undefined {
  return [...steps].toSorted((left, right) => right.updatedAt - left.updatedAt)[0];
}

function latestOpenStep(steps: readonly DurableRuntimeStep[]): DurableRuntimeStep | undefined {
  return [...steps]
    .filter(
      (step) => !["succeeded", "failed", "cancelled", "lost", "skipped"].includes(step.status),
    )
    .toSorted((left, right) => right.updatedAt - left.updatedAt)[0];
}

function inferWaitingReason(
  run: DurableRuntimeRun,
  step: DurableRuntimeStep | undefined,
): DurableCoordinationWaitingReason | undefined {
  if (run.recoveryState === "waiting_signal" || run.status === "waiting_signal") {
    return "signal";
  }
  if (run.recoveryState === "waiting_timer" || run.status === "waiting_timer") {
    return "timer";
  }
  if (run.recoveryState === "waiting_child" || run.status === "waiting_child") {
    return "child";
  }
  if (run.recoveryState === "retry_scheduled" || run.status === "retry_scheduled") {
    return "retry";
  }
  if (run.recoveryState === "claimed" || run.recoveryState === "running") {
    return "worker";
  }
  if (["unknown_after_side_effect", "requires_owner_decision"].includes(run.recoveryState)) {
    return "unknown";
  }
  if (step?.status === "waiting") {
    if (step.stepType === "fan_in") {
      return "child";
    }
    if (step.stepType === "signal") {
      return "signal";
    }
    if (step.stepType === "timer") {
      return "timer";
    }
  }
  return undefined;
}

function projectChildCounts(links: readonly DurableRuntimeLink[]): DurableCoordinationChildCounts {
  const counts: Record<DurableRuntimeLinkStatus, number> = {
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    lost: 0,
  };
  for (const link of links) {
    counts[link.status] += 1;
  }
  return {
    total: links.length,
    ...counts,
    terminal: counts.succeeded + counts.failed + counts.cancelled + counts.lost,
    open: counts.pending + counts.running,
  };
}

function projectRefs(params: {
  run: DurableRuntimeRun;
  steps: readonly DurableRuntimeStep[];
  refs: readonly DurableRuntimeRef[];
}): DurableCoordinationProjection["refs"] {
  const outputRefs = new Set<string>();
  const errorRefs = new Set<string>();
  const artifactRefs = new Set<string>();
  for (const step of params.steps) {
    if (step.outputRef) {
      outputRefs.add(step.outputRef);
    }
    if (step.errorRef) {
      errorRefs.add(step.errorRef);
    }
  }
  for (const ref of params.refs) {
    if (ref.refKind === "output") {
      outputRefs.add(ref.refId);
    } else if (ref.refKind === "error") {
      errorRefs.add(ref.refId);
    } else if (ref.refKind === "artifact") {
      artifactRefs.add(ref.refId);
    }
  }
  return {
    ...(params.run.inputRef ? { inputRef: params.run.inputRef } : {}),
    ...(params.run.checkpointRef ? { checkpointRef: params.run.checkpointRef } : {}),
    outputRefs: [...outputRefs].slice(0, MAX_PUBLIC_REFS),
    errorRefs: [...errorRefs].slice(0, MAX_PUBLIC_REFS),
    artifactRefs: [...artifactRefs].slice(0, MAX_PUBLIC_REFS),
  };
}

function projectExternalRefs(run: DurableRuntimeRun): DurableCoordinationProjection["external"] {
  const metadata = isRecord(run.metadata) ? run.metadata : {};
  const taskId = firstString(metadata.taskId, metadata.task_id);
  const taskFlowId = firstString(metadata.taskFlowId, metadata.flowId, metadata.parentFlowId);
  const sessionKey = firstString(
    metadata.sessionKey,
    run.sourceOwner === "session_store" ? run.sourceRef : undefined,
  );
  const childSessionKey = firstString(
    metadata.childSessionKey,
    run.sourceOwner === "subagent_runs" ? run.sourceRef : undefined,
  );
  const runId = firstString(metadata.runId);
  const agentId = firstString(metadata.agentId);
  const requesterAgentId = firstString(metadata.requesterAgentId);
  return {
    ...(taskId ? { taskId } : {}),
    ...(taskFlowId ? { taskFlowId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(childSessionKey ? { childSessionKey } : {}),
    ...(runId ? { runId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(requesterAgentId ? { requesterAgentId } : {}),
  };
}

function projectRecoveryDiagnostic(
  run: DurableRuntimeRun,
): DurableCoordinationRecoveryDiagnostic | undefined {
  const metadata = isRecord(run.metadata) ? run.metadata : {};
  const raw = isRecord(metadata.recoveryDiagnostic) ? metadata.recoveryDiagnostic : undefined;
  if (raw) {
    const rawState = firstString(raw.state);
    const state =
      rawState === "lost" ||
      rawState === "requires_owner_decision" ||
      rawState === "unknown_after_side_effect"
        ? rawState
        : undefined;
    if (state) {
      const reason = publicDiagnosticText(raw.reason);
      const message = publicDiagnosticText(raw.message);
      const nextAction = publicDiagnosticText(raw.nextAction) ?? "inspect_timeline";
      const safeRecoveryActions = stringArray(raw.safeRecoveryActions);
      const input = isRecord(raw.input)
        ? {
            ...(firstString(raw.input.inputRef)
              ? { inputRef: firstString(raw.input.inputRef) }
              : {}),
            ...(firstString(raw.input.inputAvailability)
              ? { inputAvailability: firstString(raw.input.inputAvailability) }
              : {}),
            ...(firstBoolean(raw.input.canReplay) !== undefined
              ? { canReplay: firstBoolean(raw.input.canReplay) }
              : {}),
            ...(publicDiagnosticText(raw.input.reason)
              ? { reason: publicDiagnosticText(raw.input.reason) }
              : {}),
            ...(firstNumber(raw.input.messageLength) !== undefined
              ? { messageLength: firstNumber(raw.input.messageLength) }
              : {}),
            ...(firstString(raw.input.messageHash)
              ? { messageHash: firstString(raw.input.messageHash) }
              : {}),
          }
        : undefined;
      return {
        state,
        severity: raw.severity === "warning" ? "warning" : "error",
        reportable: firstBoolean(raw.reportable) ?? true,
        retryable: firstBoolean(raw.retryable) ?? state === "lost",
        ...(reason ? { reason } : {}),
        message:
          message ??
          (state === "lost"
            ? "Runtime run was marked lost during durable recovery."
            : "Runtime run needs owner reconciliation before retry."),
        nextAction,
        ...(safeRecoveryActions ? { safeRecoveryActions } : {}),
        ...(input && Object.keys(input).length > 0 ? { input } : {}),
        ...(firstNumber(raw.detectedAt) !== undefined
          ? { detectedAt: firstNumber(raw.detectedAt) }
          : {}),
      };
    }
  }
  if (run.status === "lost" || run.recoveryState === "lost") {
    return {
      state: "lost",
      severity: "error",
      reportable: true,
      retryable: true,
      message: "Runtime run was marked lost during durable recovery.",
      nextAction: "inspect_timeline",
      ...(run.completedAt ? { detectedAt: run.completedAt } : {}),
    };
  }
  if (run.recoveryState === "unknown_after_side_effect") {
    return {
      state: "unknown_after_side_effect",
      severity: "warning",
      reportable: true,
      retryable: false,
      message: "Runtime run may have completed side effects and needs owner reconciliation.",
      nextAction: "inspect_timeline",
    };
  }
  if (run.recoveryState === "requires_owner_decision") {
    return {
      state: "requires_owner_decision",
      severity: "warning",
      reportable: true,
      retryable: false,
      message: "Runtime execution is blocked until its owner resolves a recovery prerequisite.",
      nextAction: "inspect_timeline",
    };
  }
  return undefined;
}

export function projectDurableCoordination(params: {
  run: DurableRuntimeRun;
  steps?: readonly DurableRuntimeStep[];
  childLinks?: readonly DurableRuntimeLink[];
  refs?: readonly DurableRuntimeRef[];
}): DurableCoordinationProjection {
  const steps = params.steps ?? [];
  const childLinks = params.childLinks ?? [];
  const currentStep = latestOpenStep(steps) ?? latestStep(steps);
  const waitingReason = inferWaitingReason(params.run, currentStep);
  const recovery = projectRecoveryDiagnostic(params.run);
  return {
    runtimeRunId: params.run.runtimeRunId,
    operationKind: params.run.operationKind,
    operationVersion: params.run.operationVersion,
    status: params.run.status,
    recoveryState: params.run.recoveryState,
    ...(params.run.sourceOwner ? { sourceOwner: params.run.sourceOwner } : {}),
    ...(params.run.sourceRef ? { sourceRef: params.run.sourceRef } : {}),
    ...(params.run.parentRuntimeRunId ? { parentRuntimeRunId: params.run.parentRuntimeRunId } : {}),
    ...(params.run.parentStepId ? { parentStepId: params.run.parentStepId } : {}),
    ...(params.run.workUnitId ? { workUnitId: params.run.workUnitId } : {}),
    ...(params.run.reportRouteId ? { reportRouteId: params.run.reportRouteId } : {}),
    ...(currentStep ? { currentStepId: currentStep.stepId } : {}),
    ...(waitingReason ? { waitingReason } : {}),
    ...(params.run.heartbeatAt ? { heartbeatAt: params.run.heartbeatAt } : {}),
    createdAt: params.run.createdAt,
    updatedAt: params.run.updatedAt,
    ...(params.run.completedAt ? { completedAt: params.run.completedAt } : {}),
    refs: projectRefs({ run: params.run, steps, refs: params.refs ?? [] }),
    external: projectExternalRefs(params.run),
    children: projectChildCounts(childLinks),
    ...(recovery ? { recovery } : {}),
  };
}

export function projectDurableRunSummary(params: {
  run: DurableRuntimeRun;
  steps?: readonly DurableRuntimeStep[];
  childLinks?: readonly DurableRuntimeLink[];
}): DurableRunSummary {
  const { refs: _refs, external: _external, ...summary } = projectDurableCoordination(params);
  return summary;
}

export function projectDurableStep(step: DurableRuntimeStep): DurableStepSummary {
  return {
    runtimeRunId: step.runtimeRunId,
    stepId: step.stepId,
    ...(step.parentStepId ? { parentStepId: step.parentStepId } : {}),
    stepType: step.stepType,
    status: step.status,
    recoveryState: step.recoveryState,
    attempt: step.attempt,
    ...(step.maxAttempts !== undefined ? { maxAttempts: step.maxAttempts } : {}),
    ...(step.inputRef ? { inputRef: step.inputRef } : {}),
    ...(step.outputRef ? { outputRef: step.outputRef } : {}),
    ...(step.errorRef ? { errorRef: step.errorRef } : {}),
    ...(step.checkpointRef ? { checkpointRef: step.checkpointRef } : {}),
    ...(step.claimExpiresAt !== undefined ? { claimExpiresAt: step.claimExpiresAt } : {}),
    ...(step.heartbeatAt !== undefined ? { heartbeatAt: step.heartbeatAt } : {}),
    createdAt: step.createdAt,
    ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
    updatedAt: step.updatedAt,
    ...(step.completedAt !== undefined ? { completedAt: step.completedAt } : {}),
  };
}

export function projectDurableEvent(event: DurableRuntimeEvent): DurableEventSummary {
  return {
    eventId: event.eventId,
    runtimeRunId: event.runtimeRunId,
    eventSeq: event.eventSeq,
    eventType: event.eventType,
    eventTime: event.eventTime,
    ...(event.stepId ? { stepId: event.stepId } : {}),
    ...(event.agentInvocationId ? { agentInvocationId: event.agentInvocationId } : {}),
    ...(event.toolInvocationId ? { toolInvocationId: event.toolInvocationId } : {}),
    ...(event.checkpointRef ? { checkpointRef: event.checkpointRef } : {}),
    ...(event.causationEventId ? { causationEventId: event.causationEventId } : {}),
    ...(event.correlationId ? { correlationId: event.correlationId } : {}),
    recordedAt: event.recordedAt,
  };
}

export function projectDurableLink(link: DurableRuntimeLink): DurableLinkSummary {
  return {
    parentRuntimeRunId: link.parentRuntimeRunId,
    parentStepId: link.parentStepId,
    childRuntimeRunId: link.childRuntimeRunId,
    linkType: link.linkType,
    status: link.status,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  };
}

export function projectDurableSignal(signal: DurableRuntimeSignal): DurableSignalSummary {
  return {
    signalId: signal.signalId,
    runtimeRunId: signal.runtimeRunId,
    ...(signal.stepId ? { stepId: signal.stepId } : {}),
    signalType: signal.signalType,
    ...(signal.payloadRef ? { payloadRef: signal.payloadRef } : {}),
    ...(signal.correlationId ? { correlationId: signal.correlationId } : {}),
    receivedAt: signal.receivedAt,
    ...(signal.consumedAt !== undefined ? { consumedAt: signal.consumedAt } : {}),
  };
}

export function projectDurableTimer(timer: DurableRuntimeTimer): DurableTimerSummary {
  return {
    timerId: timer.timerId,
    runtimeRunId: timer.runtimeRunId,
    ...(timer.stepId ? { stepId: timer.stepId } : {}),
    timerType: timer.timerType,
    dueAt: timer.dueAt,
    status: timer.status,
    createdAt: timer.createdAt,
    ...(timer.firedAt !== undefined ? { firedAt: timer.firedAt } : {}),
    ...(timer.cancelledAt !== undefined ? { cancelledAt: timer.cancelledAt } : {}),
  };
}

export function projectDurableRef(ref: DurableRuntimeRef): DurableRefSummary {
  return {
    refId: ref.refId,
    runtimeRunId: ref.runtimeRunId,
    ...(ref.stepId ? { stepId: ref.stepId } : {}),
    refKind: ref.refKind,
    ...(ref.mediaType ? { mediaType: ref.mediaType } : {}),
    ...(ref.hash ? { hash: ref.hash } : {}),
    storageKind: ref.storageKind,
    createdAt: ref.createdAt,
  };
}

export function projectDurableObligation(
  obligation: DurableUnresolvedObligation,
): DurableObligationSummary {
  return {
    obligationId: obligation.obligationId,
    sourceOwner: obligation.sourceOwner,
    sourceRef: obligation.sourceRef,
    kind: obligation.kind,
    ...(obligation.runtimeRunId ? { runtimeRunId: obligation.runtimeRunId } : {}),
    ...(obligation.stepId ? { stepId: obligation.stepId } : {}),
    ...(obligation.wakeId ? { wakeId: obligation.wakeId } : {}),
    ...(obligation.uncertaintyFactId ? { uncertaintyFactId: obligation.uncertaintyFactId } : {}),
    ...(obligation.reason ? { reason: requiredPublicDiagnosticText(obligation.reason) } : {}),
    status: obligation.status,
    createdAt: obligation.createdAt,
    updatedAt: obligation.updatedAt,
  };
}

export function projectDurableWake(wake: WakeObligation): DurableWakeSummary {
  return {
    wakeId: wake.wakeId,
    sourceOwner: wake.sourceOwner,
    sourceRef: wake.sourceRef,
    ...(wake.parentRunId ? { parentRunId: wake.parentRunId } : {}),
    ...(wake.targetKind ? { targetKind: wake.targetKind } : {}),
    ...(wake.targetRef ? { targetRef: wake.targetRef } : {}),
    ...(wake.ownerKind ? { ownerKind: wake.ownerKind } : {}),
    ...(wake.ownerRef ? { ownerRef: wake.ownerRef } : {}),
    ...(wake.reportRouteRef ? { reportRouteRef: wake.reportRouteRef } : {}),
    ...(wake.targetResolutionStatus ? { targetResolutionStatus: wake.targetResolutionStatus } : {}),
    ...(wake.targetResolutionReason
      ? { targetResolutionReason: requiredPublicDiagnosticText(wake.targetResolutionReason) }
      : {}),
    reason: wake.reason,
    ...(wake.factsRef ? { factsRef: wake.factsRef } : {}),
    ...(wake.sourceRunId ? { sourceRunId: wake.sourceRunId } : {}),
    attemptCount: wake.attemptCount,
    ...(wake.lastAttemptAt ? { lastAttemptAt: wake.lastAttemptAt } : {}),
    ...(wake.ackedAt ? { ackedAt: wake.ackedAt } : {}),
    ...(wake.failedReason ? { failedReason: requiredPublicDiagnosticText(wake.failedReason) } : {}),
    status: wake.status,
    createdAt: wake.createdAt,
    updatedAt: wake.updatedAt,
  };
}

export function projectDurableUncertainty(fact: UncertaintyFact): DurableUncertaintySummary {
  return {
    factId: fact.factId,
    sourceOwner: fact.sourceOwner,
    sourceRef: fact.sourceRef,
    kind: fact.kind,
    ...(fact.sourceRunId ? { sourceRunId: fact.sourceRunId } : {}),
    ...(fact.stepId ? { stepId: fact.stepId } : {}),
    ...(fact.eventId ? { eventId: fact.eventId } : {}),
    ...(fact.refId ? { refId: fact.refId } : {}),
    ...(fact.factsRef ? { factsRef: fact.factsRef } : {}),
    status: fact.status,
    ...(fact.resolutionKind
      ? { resolutionKind: fact.resolutionKind.slice(0, MAX_PUBLIC_TEXT) }
      : {}),
    ...(fact.resolutionRef ? { resolutionRef: fact.resolutionRef.slice(0, MAX_PUBLIC_TEXT) } : {}),
    ...(fact.resolvedAt !== undefined ? { resolvedAt: fact.resolvedAt } : {}),
    createdAt: fact.createdAt,
    updatedAt: fact.updatedAt,
  };
}

export function projectDurableDeliveryAttempt(
  attempt: DeliveryAttemptEvidence,
): DurableDeliveryAttemptSummary {
  return {
    deliveryAttemptId: attempt.deliveryAttemptId,
    sourceOwner: attempt.sourceOwner,
    sourceRef: attempt.sourceRef,
    wakeId: attempt.wakeId,
    ...(attempt.targetKind ? { targetKind: attempt.targetKind } : {}),
    ...(attempt.targetRef ? { targetRef: attempt.targetRef } : {}),
    ...(attempt.routeKind ? { routeKind: attempt.routeKind } : {}),
    ...(attempt.routeRef ? { routeRef: attempt.routeRef } : {}),
    status: attempt.status,
    ...(attempt.error ? { error: requiredPublicDiagnosticText(attempt.error) } : {}),
    scheduledAt: attempt.scheduledAt,
    ...(attempt.attemptedAt !== undefined ? { attemptedAt: attempt.attemptedAt } : {}),
    ...(attempt.handoffAcceptedAt !== undefined
      ? { handoffAcceptedAt: attempt.handoffAcceptedAt }
      : {}),
    ...(attempt.failedAt !== undefined ? { failedAt: attempt.failedAt } : {}),
    ...(attempt.unknownAt !== undefined ? { unknownAt: attempt.unknownAt } : {}),
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
  };
}

export function projectDurableWakeInspection(
  inspection: WakeObligationInspection,
): DurableWakeInspectionSummary {
  const target = inspection.targetResolution;
  return {
    wake: projectDurableWake(inspection.wake),
    targetResolution: {
      ...(target.status ? { status: target.status } : {}),
      ...(target.reason ? { reason: requiredPublicDiagnosticText(target.reason) } : {}),
      ...(target.targetKind ? { targetKind: target.targetKind } : {}),
      ...(target.targetRef ? { targetRef: target.targetRef } : {}),
      ...(target.ownerKind ? { ownerKind: target.ownerKind } : {}),
      ...(target.ownerRef ? { ownerRef: target.ownerRef } : {}),
      ...(target.reportRouteRef ? { reportRouteRef: target.reportRouteRef } : {}),
      ...(target.factsRef ? { factsRef: target.factsRef } : {}),
      ...(target.sourceRunId ? { sourceRunId: target.sourceRunId } : {}),
    },
    deliveryAttempts: inspection.deliveryAttemptEvidence
      .slice(0, 500)
      .map(projectDurableDeliveryAttempt),
    unresolvedUncertainty: inspection.unresolvedUncertaintyFacts
      .slice(0, 500)
      .map(projectDurableUncertainty),
    source: {
      sourceOwner: inspection.sourceRefs.sourceOwner,
      sourceRef: inspection.sourceRefs.sourceRef,
      ...(inspection.sourceRefs.factsRef ? { factsRef: inspection.sourceRefs.factsRef } : {}),
      ...(inspection.sourceRefs.sourceRunId
        ? { sourceRunId: inspection.sourceRefs.sourceRunId }
        : {}),
      ...(inspection.sourceRefs.parentRunId
        ? { parentRunId: inspection.sourceRefs.parentRunId }
        : {}),
    },
  };
}

export function projectDurableStoreStats(stats: DurableRuntimeStoreStats): DurablePublicStoreStats {
  return {
    runs: stats.runs,
    events: stats.events,
    steps: stats.steps,
    openRuns: stats.openRuns,
    pendingWakes: stats.pendingWakes,
    unresolvedUncertaintyFacts: stats.unresolvedUncertaintyFacts,
  };
}

export function projectDurableHealthSnapshot(
  snapshot: DurableRuntimeHealthSnapshot,
): DurablePublicHealthSnapshot {
  return {
    status: snapshot.status,
    ...(snapshot.lastSuccessAt ? { lastSuccessAt: snapshot.lastSuccessAt } : {}),
    ...(snapshot.lastFailure
      ? {
          lastFailure: {
            component: snapshot.lastFailure.component,
            operation: snapshot.lastFailure.operation,
            message: requiredPublicDiagnosticText(snapshot.lastFailure.message).slice(0, 500),
            failedAt: snapshot.lastFailure.failedAt,
            failureCount: snapshot.lastFailure.failureCount,
          },
        }
      : {}),
  };
}

export function formatDurableInspectionStoreError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/not initialized/i.test(message)) {
    return "Durable runtime store is not initialized.";
  }
  const missingTable = message.match(/missing required table ([A-Za-z0-9_]+)/i)?.[1];
  if (missingTable) {
    return `Durable runtime store is missing required table ${missingTable}.`;
  }
  return "Durable runtime store is unavailable.";
}

export function projectDurableRunInspection(params: {
  run: DurableRuntimeRun;
  steps: readonly DurableRuntimeStep[];
  children: readonly DurableRuntimeLink[];
  parents: readonly DurableRuntimeLink[];
  signals: readonly DurableRuntimeSignal[];
  refs: readonly DurableRuntimeRef[];
  timers: readonly DurableRuntimeTimer[];
  timeline: readonly DurableRuntimeEvent[];
}): DurableRunInspection {
  const coordination = projectDurableCoordination({
    run: params.run,
    steps: params.steps,
    childLinks: params.children,
    refs: params.refs,
  });
  const { refs: _refs, external: _external, ...run } = coordination;
  return {
    run,
    coordination,
    steps: params.steps.map(projectDurableStep),
    children: params.children.map(projectDurableLink),
    parents: params.parents.map(projectDurableLink),
    signals: params.signals.map(projectDurableSignal),
    refs: params.refs.map(projectDurableRef),
    timers: params.timers.map(projectDurableTimer),
    timeline: params.timeline.map(projectDurableEvent),
  };
}
