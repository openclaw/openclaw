// Builds stable coordination projections for task, TaskFlow, and Workboard surfaces.
import type {
  DurableRecoveryState,
  DurableWorkflowLink,
  DurableWorkflowRef,
  DurableWorkflowRun,
  DurableWorkflowRunStatus,
  DurableWorkflowStep,
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
  taskId?: string;
  taskFlowId?: string;
  workboardCardId?: string;
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

export type DurableCoordinationProjection = {
  workflowRunId: string;
  workflowId: string;
  workflowVersion: string;
  status: DurableWorkflowRunStatus;
  recoveryState: DurableRecoveryState;
  sourceType?: string;
  sourceRef?: string;
  parentWorkflowRunId?: string;
  parentStepId?: string;
  currentStepId?: string;
  waitingReason?: DurableCoordinationWaitingReason;
  heartbeatAt?: number;
  updatedAt: number;
  completedAt?: number;
  refs: DurableCoordinationRefs;
  external: DurableCoordinationExternalRefs;
  children: DurableCoordinationChildCounts;
  controls: DurableCoordinationControls;
};

export type BuildDurableCoordinationProjectionInput = {
  run: DurableWorkflowRun;
  steps?: readonly DurableWorkflowStep[];
  childLinks?: readonly DurableWorkflowLink[];
  refs?: readonly DurableWorkflowRef[];
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

function latestStep(steps: readonly DurableWorkflowStep[]): DurableWorkflowStep | undefined {
  return [...steps].sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

function latestOpenStep(steps: readonly DurableWorkflowStep[]): DurableWorkflowStep | undefined {
  return [...steps]
    .filter(
      (step) =>
        step.status !== "succeeded" &&
        step.status !== "failed" &&
        step.status !== "cancelled" &&
        step.status !== "lost" &&
        step.status !== "skipped",
    )
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

function inferWaitingReason(params: {
  run: DurableWorkflowRun;
  currentStep?: DurableWorkflowStep;
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
  if (params.currentStep?.stepType === "signal" && params.currentStep.status === "waiting") {
    return "signal";
  }
  if (params.currentStep?.stepType === "timer" && params.currentStep.status === "waiting") {
    return "timer";
  }
  return undefined;
}

function childCounts(links: readonly DurableWorkflowLink[]): DurableCoordinationChildCounts {
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
  run: DurableWorkflowRun;
  steps: readonly DurableWorkflowStep[];
  refs: readonly DurableWorkflowRef[];
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
  run: DurableWorkflowRun,
): DurableCoordinationExternalRefs {
  const metadata = isRecord(run.metadata) ? run.metadata : {};
  const taskId = firstString(metadata.taskId, metadata.task_id);
  const taskFlowId = firstString(metadata.taskFlowId, metadata.flowId, metadata.parentFlowId);
  const workboardCardId = firstString(metadata.workboardCardId, metadata.cardId);
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
    ...(taskId ? { taskId } : {}),
    ...(taskFlowId ? { taskFlowId } : {}),
    ...(workboardCardId ? { workboardCardId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(childSessionKey ? { childSessionKey } : {}),
    ...(runId ? { runId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(requesterAgentId ? { requesterAgentId } : {}),
  };
}

function isTerminalRun(status: DurableWorkflowRunStatus): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost"
  );
}

export function buildDurableCoordinationProjection(
  input: BuildDurableCoordinationProjectionInput,
): DurableCoordinationProjection {
  const steps = input.steps ?? [];
  const childLinks = input.childLinks ?? [];
  const currentStep = latestOpenStep(steps) ?? latestStep(steps);
  const waitingReason = inferWaitingReason({ run: input.run, currentStep });
  const terminal = isTerminalRun(input.run.status);
  return {
    workflowRunId: input.run.workflowRunId,
    workflowId: input.run.workflowId,
    workflowVersion: input.run.workflowVersion,
    status: input.run.status,
    recoveryState: input.run.recoveryState,
    ...(input.run.sourceType ? { sourceType: input.run.sourceType } : {}),
    ...(input.run.sourceRef ? { sourceRef: input.run.sourceRef } : {}),
    ...(input.run.parentWorkflowRunId
      ? { parentWorkflowRunId: input.run.parentWorkflowRunId }
      : {}),
    ...(input.run.parentStepId ? { parentStepId: input.run.parentStepId } : {}),
    ...(currentStep ? { currentStepId: currentStep.stepId } : {}),
    ...(waitingReason ? { waitingReason } : {}),
    ...(input.run.heartbeatAt ? { heartbeatAt: input.run.heartbeatAt } : {}),
    updatedAt: input.run.updatedAt,
    ...(input.run.completedAt ? { completedAt: input.run.completedAt } : {}),
    refs: refSummary({ run: input.run, steps, refs: input.refs ?? [] }),
    external: extractDurableCoordinationExternalRefs(input.run),
    children: childCounts(childLinks),
    controls: {
      canCancel: !terminal,
      canRetry: terminal || input.run.recoveryState === "unknown_after_side_effect",
      canResume:
        !terminal &&
        (input.run.status === "waiting" ||
          input.run.status === "waiting_signal" ||
          input.run.status === "waiting_timer" ||
          input.run.status === "waiting_child" ||
          input.run.status === "retry_scheduled"),
      canSignal:
        !terminal &&
        (input.run.status === "waiting" ||
          input.run.status === "waiting_signal" ||
          input.run.recoveryState === "waiting_signal"),
      canOpenTimeline: true,
    },
  };
}

export function buildDurableTaskFlowStateProjection(
  projection: DurableCoordinationProjection,
): Record<string, unknown> {
  return {
    workflowRunId: projection.workflowRunId,
    workflowId: projection.workflowId,
    status: projection.status,
    recoveryState: projection.recoveryState,
    ...(projection.currentStepId ? { currentStepId: projection.currentStepId } : {}),
    ...(projection.waitingReason ? { waitingReason: projection.waitingReason } : {}),
    children: projection.children,
    external: projection.external,
    updatedAt: projection.updatedAt,
  };
}

export function buildDurableWorkboardMetadataProjection(
  projection: DurableCoordinationProjection,
): Record<string, unknown> {
  return {
    workflowRunId: projection.workflowRunId,
    workflowId: projection.workflowId,
    workflowVersion: projection.workflowVersion,
    status: projection.status,
    recoveryState: projection.recoveryState,
    ...(projection.waitingReason ? { waitingReason: projection.waitingReason } : {}),
    ...(projection.currentStepId ? { currentStepId: projection.currentStepId } : {}),
    ...projection.external,
    children: projection.children,
    timelineCommand: `openclaw durable timeline ${projection.workflowRunId}`,
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
