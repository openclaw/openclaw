// Builds stable durable runtime coordination projections for operator and integration surfaces.
import type {
  DurableRecoveryState,
  DurableRuntimeLink,
  DurableRuntimeRef,
  DurableRuntimeRun,
  DurableRuntimeRunStatus,
  DurableRuntimeStep,
} from "./types.js";

export const DURABLE_COORDINATION_METADATA_KEY = "durable";

export type DurableCoordinationWaitingReason =
  | "signal"
  | "timer"
  | "child"
  | "retry"
  | "worker"
  | "unknown";

export type DurableCoordinationExternalRefs = {
  workUnitId?: string;
  reportRouteId?: string;
  taskId?: string;
  taskFlowId?: string;
  sessionKey?: string;
  childSessionKey?: string;
  runId?: string;
  agentId?: string;
  requesterAgentId?: string;
};

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

export type DurableCoordinationRefs = {
  inputRef?: string;
  checkpointRef?: string;
  outputRefs: string[];
  errorRefs: string[];
  artifactRefs: string[];
};

export type DurableCoordinationControls = {
  canCancel: boolean;
  canRetry: boolean;
  canResume: boolean;
  canSignal: boolean;
  canOpenTimeline: boolean;
};

export type DurableCoordinationRecoveryDiagnostic = {
  state: "lost" | "unknown_after_side_effect";
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
  processInstanceId?: string;
};

export type DurableCoordinationProjection = {
  runtimeRunId: string;
  operationKind: string;
  operationVersion: string;
  status: DurableRuntimeRunStatus;
  recoveryState: DurableRecoveryState;
  sourceType?: string;
  sourceRef?: string;
  parentRuntimeRunId?: string;
  parentStepId?: string;
  workUnitId?: string;
  reportRouteId?: string;
  currentStepId?: string;
  waitingReason?: DurableCoordinationWaitingReason;
  heartbeatAt?: number;
  updatedAt: number;
  completedAt?: number;
  refs: DurableCoordinationRefs;
  external: DurableCoordinationExternalRefs;
  children: DurableCoordinationChildCounts;
  controls: DurableCoordinationControls;
  recovery?: DurableCoordinationRecoveryDiagnostic;
};

export type BuildDurableCoordinationProjectionInput = {
  run: DurableRuntimeRun;
  steps?: readonly DurableRuntimeStep[];
  childLinks?: readonly DurableRuntimeLink[];
  refs?: readonly DurableRuntimeRef[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return values.length > 0 ? values.map((item) => item.trim()) : undefined;
}

function latestStep(steps: readonly DurableRuntimeStep[]): DurableRuntimeStep | undefined {
  return steps.toSorted((left, right) => right.updatedAt - left.updatedAt)[0];
}

function latestOpenStep(steps: readonly DurableRuntimeStep[]): DurableRuntimeStep | undefined {
  return steps
    .filter(
      (step) =>
        step.status !== "succeeded" &&
        step.status !== "failed" &&
        step.status !== "cancelled" &&
        step.status !== "lost" &&
        step.status !== "skipped",
    )
    .toSorted((left, right) => right.updatedAt - left.updatedAt)[0];
}

function inferWaitingReason(params: {
  run: DurableRuntimeRun;
  currentStep?: DurableRuntimeStep;
}): DurableCoordinationWaitingReason | undefined {
  if (params.run.recoveryState === "waiting_signal" || params.run.status === "waiting_signal") {
    return "signal";
  }
  if (params.run.recoveryState === "waiting_timer" || params.run.status === "waiting_timer") {
    return "timer";
  }
  if (params.run.recoveryState === "waiting_child" || params.run.status === "waiting_child") {
    return "child";
  }
  if (params.run.recoveryState === "retry_scheduled" || params.run.status === "retry_scheduled") {
    return "retry";
  }
  if (params.run.recoveryState === "claimed" || params.run.recoveryState === "running") {
    return "worker";
  }
  if (params.run.recoveryState === "unknown_after_side_effect") {
    return "unknown";
  }
  if (params.currentStep?.stepType === "fan_in" && params.currentStep.status === "waiting") {
    return "child";
  }
  if (params.currentStep?.stepType === "result_mailbox") {
    return "child";
  }
  if (params.currentStep?.stepType === "signal" && params.currentStep.status === "waiting") {
    return "signal";
  }
  if (params.currentStep?.stepType === "timer" && params.currentStep.status === "waiting") {
    return "timer";
  }
  return undefined;
}

function childCounts(links: readonly DurableRuntimeLink[]): DurableCoordinationChildCounts {
  const counts: DurableCoordinationChildCounts = {
    total: links.length,
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    lost: 0,
    terminal: 0,
    open: 0,
  };
  for (const link of links) {
    counts[link.status] += 1;
  }
  counts.terminal = counts.succeeded + counts.failed + counts.cancelled + counts.lost;
  counts.open = counts.pending + counts.running;
  return counts;
}

function refSummary(params: {
  run: DurableRuntimeRun;
  steps: readonly DurableRuntimeStep[];
  refs: readonly DurableRuntimeRef[];
}): DurableCoordinationRefs {
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
    outputRefs: [...outputRefs],
    errorRefs: [...errorRefs],
    artifactRefs: [...artifactRefs],
  };
}

export function extractDurableCoordinationExternalRefs(
  run: DurableRuntimeRun,
): DurableCoordinationExternalRefs {
  const metadata = isRecord(run.metadata) ? run.metadata : {};
  const workUnitId = firstString(run.workUnitId, metadata.workUnitId, metadata.work_unit_id);
  const reportRouteId = firstString(
    run.reportRouteId,
    metadata.reportRouteId,
    metadata.report_route_id,
  );
  const taskId = firstString(metadata.taskId, metadata.task_id);
  const taskFlowId = firstString(metadata.taskFlowId, metadata.flowId, metadata.parentFlowId);
  const sessionKey = firstString(
    metadata.sessionKey,
    run.sourceType === "agent_turn" ? run.sourceRef : undefined,
  );
  const childSessionKey = firstString(
    metadata.childSessionKey,
    run.sourceType === "subagent" ? run.sourceRef : undefined,
  );
  const runId = firstString(metadata.runId, run.idempotencyKey);
  const agentId = firstString(metadata.agentId);
  const requesterAgentId = firstString(metadata.requesterAgentId);
  return {
    ...(workUnitId ? { workUnitId } : {}),
    ...(reportRouteId ? { reportRouteId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(taskFlowId ? { taskFlowId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(childSessionKey ? { childSessionKey } : {}),
    ...(runId ? { runId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(requesterAgentId ? { requesterAgentId } : {}),
  };
}

function extractRecoveryDiagnostic(
  run: DurableRuntimeRun,
): DurableCoordinationRecoveryDiagnostic | undefined {
  const metadata = isRecord(run.metadata) ? run.metadata : {};
  const raw = metadata.recoveryDiagnostic;
  if (isRecord(raw)) {
    const rawState = firstString(raw.state);
    const state =
      rawState === "lost" || rawState === "unknown_after_side_effect" ? rawState : undefined;
    if (state) {
      const rawSeverity = firstString(raw.severity);
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
            ...(firstString(raw.input.reason) ? { reason: firstString(raw.input.reason) } : {}),
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
        severity: rawSeverity === "warning" ? "warning" : "error",
        reportable: firstBoolean(raw.reportable) ?? true,
        retryable: firstBoolean(raw.retryable) ?? state === "lost",
        ...(firstString(raw.reason) ? { reason: firstString(raw.reason) } : {}),
        message:
          firstString(raw.message) ??
          (state === "lost"
            ? "Runtime run was marked lost during durable recovery."
            : "Runtime run may have completed side effects and needs operator reconciliation."),
        nextAction:
          firstString(raw.nextAction) ??
          (state === "lost" ? "inspect_timeline_then_retry" : "inspect_timeline_then_reconcile"),
        ...(stringArray(raw.safeRecoveryActions)
          ? { safeRecoveryActions: stringArray(raw.safeRecoveryActions) }
          : {}),
        ...(input && Object.keys(input).length > 0 ? { input } : {}),
        ...(firstNumber(raw.detectedAt) ? { detectedAt: firstNumber(raw.detectedAt) } : {}),
        ...(firstString(raw.processInstanceId)
          ? { processInstanceId: firstString(raw.processInstanceId) }
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
      nextAction: "inspect_timeline_then_retry",
      ...(run.completedAt ? { detectedAt: run.completedAt } : {}),
    };
  }
  if (run.recoveryState === "unknown_after_side_effect") {
    return {
      state: "unknown_after_side_effect",
      severity: "warning",
      reportable: true,
      retryable: false,
      message: "Runtime run may have completed side effects and needs operator reconciliation.",
      nextAction: "inspect_timeline_then_reconcile",
    };
  }
  return undefined;
}

export function buildDurableCoordinationProjection(
  input: BuildDurableCoordinationProjectionInput,
): DurableCoordinationProjection {
  const steps = input.steps ?? [];
  const childLinks = input.childLinks ?? [];
  const currentStep = latestOpenStep(steps) ?? latestStep(steps);
  const waitingReason = inferWaitingReason({ run: input.run, currentStep });
  const recovery = extractRecoveryDiagnostic(input.run);
  return {
    runtimeRunId: input.run.runtimeRunId,
    operationKind: input.run.operationKind,
    operationVersion: input.run.operationVersion,
    status: input.run.status,
    recoveryState: input.run.recoveryState,
    ...(input.run.sourceType ? { sourceType: input.run.sourceType } : {}),
    ...(input.run.sourceRef ? { sourceRef: input.run.sourceRef } : {}),
    ...(input.run.parentRuntimeRunId ? { parentRuntimeRunId: input.run.parentRuntimeRunId } : {}),
    ...(input.run.parentStepId ? { parentStepId: input.run.parentStepId } : {}),
    ...(input.run.workUnitId ? { workUnitId: input.run.workUnitId } : {}),
    ...(input.run.reportRouteId ? { reportRouteId: input.run.reportRouteId } : {}),
    ...(currentStep ? { currentStepId: currentStep.stepId } : {}),
    ...(waitingReason ? { waitingReason } : {}),
    ...(input.run.heartbeatAt ? { heartbeatAt: input.run.heartbeatAt } : {}),
    updatedAt: input.run.updatedAt,
    ...(input.run.completedAt ? { completedAt: input.run.completedAt } : {}),
    refs: refSummary({ run: input.run, steps, refs: input.refs ?? [] }),
    external: extractDurableCoordinationExternalRefs(input.run),
    children: childCounts(childLinks),
    controls: {
      canCancel: false,
      canRetry: false,
      canResume: false,
      canSignal: false,
      canOpenTimeline: true,
    },
    ...(recovery ? { recovery } : {}),
  };
}

export function buildDurableCoordinationMetadataProjection(
  projection: DurableCoordinationProjection,
): Record<string, unknown> {
  return {
    runtimeRunId: projection.runtimeRunId,
    operationKind: projection.operationKind,
    status: projection.status,
    recoveryState: projection.recoveryState,
    ...(projection.workUnitId ? { workUnitId: projection.workUnitId } : {}),
    ...(projection.reportRouteId ? { reportRouteId: projection.reportRouteId } : {}),
    ...(projection.currentStepId ? { currentStepId: projection.currentStepId } : {}),
    ...(projection.waitingReason ? { waitingReason: projection.waitingReason } : {}),
    children: projection.children,
    ...(projection.recovery ? { recovery: projection.recovery } : {}),
    external: projection.external,
    updatedAt: projection.updatedAt,
  };
}

export function mergeDurableProjectionIntoJsonObject(
  current: unknown,
  durable: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(isRecord(current) ? current : {}),
    [DURABLE_COORDINATION_METADATA_KEY]: durable,
  };
}
