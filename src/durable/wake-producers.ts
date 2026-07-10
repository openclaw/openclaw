import type {
  DurableRuntimeLink,
  DurableRuntimeRun,
  DurableRuntimeStore,
  DurableWake,
  DurableWakeReason,
} from "./types.js";
import {
  resolveDurableWakeTarget,
  type DurableWakeTargetCandidate,
  type DurableWakeTargetResolutionFacts,
} from "./wake-target-resolver.js";

const DEFAULT_OPERATOR_ROUTE: DurableWakeTargetCandidate = {
  kind: "operator",
  ref: "operator",
  ownerKind: "operator",
  ownerRef: "operator",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function runSessionKey(run: DurableRuntimeRun | undefined): string | undefined {
  if (!run) {
    return undefined;
  }
  const metadata = isRecord(run.metadata) ? run.metadata : {};
  return optionalString(metadata.sessionKey, run.sourceRef);
}

function runReportRouteRef(run: DurableRuntimeRun | undefined): string | undefined {
  if (!run) {
    return undefined;
  }
  const metadata = isRecord(run.metadata) ? run.metadata : {};
  return optionalString(run.reportRouteId, metadata.reportRouteId);
}

export function durableWakeTargetCandidateFromRun(
  run: DurableRuntimeRun | undefined,
): DurableWakeTargetCandidate | undefined {
  if (!run) {
    return undefined;
  }
  const sessionKey = runSessionKey(run);
  const reportRouteRef = runReportRouteRef(run);
  if (sessionKey) {
    return {
      kind: "agent_session",
      ref: sessionKey,
      ownerKind: "agent_session",
      ownerRef: sessionKey,
      sessionKey,
      ...(reportRouteRef ? { reportRouteRef } : {}),
    };
  }
  return {
    kind: "run",
    ref: run.runtimeRunId,
    ownerKind: "run",
    ownerRef: run.runtimeRunId,
    ...(reportRouteRef ? { reportRouteRef } : {}),
  };
}

export function durableWakeReportRouteCandidateFromRun(
  run: DurableRuntimeRun | undefined,
): DurableWakeTargetCandidate | undefined {
  const reportRouteRef = runReportRouteRef(run);
  if (!reportRouteRef) {
    return undefined;
  }
  return {
    kind: "channel_route",
    ref: reportRouteRef,
    ownerKind: "agent_session",
    ownerRef: runSessionKey(run) ?? run?.runtimeRunId ?? reportRouteRef,
    reportRouteRef,
    external: true,
  };
}

function missingAgentSessionCandidate(
  sessionKey: string | undefined,
): DurableWakeTargetCandidate | undefined {
  if (!sessionKey) {
    return undefined;
  }
  return {
    kind: "agent_session",
    ref: sessionKey,
    ownerKind: "agent_session",
    ownerRef: sessionKey,
    sessionKey,
    live: false,
  };
}

export function recordDurableWakeObligation(params: {
  store: DurableRuntimeStore;
  reason: DurableWakeReason;
  dedupeKey: string;
  facts: DurableWakeTargetResolutionFacts;
  sourceRunId?: string;
  factsRef?: string;
  evidence?: Record<string, unknown>;
  now?: number;
}): DurableWake {
  const resolved = resolveDurableWakeTarget({
    ...params.facts,
    operatorRoute: params.facts.operatorRoute ?? DEFAULT_OPERATOR_ROUTE,
  });
  return params.store.createDurableWake({
    targetKind: resolved.targetKind,
    targetRef: resolved.targetRef,
    ownerKind: resolved.ownerKind,
    ownerRef: resolved.ownerRef,
    reportRouteRef: resolved.reportRouteRef,
    targetResolutionStatus: resolved.status,
    targetResolutionReason: resolved.resolutionReason,
    reason: params.reason,
    factsRef: params.factsRef,
    sourceRunId: params.sourceRunId ?? params.facts.sourceRunId,
    dedupeKey: params.dedupeKey,
    metadata: {
      producer: "durable_wake_producer",
      diagnostics: resolved.diagnostics,
      ...(params.evidence ? { evidence: params.evidence } : {}),
    },
    now: params.now,
  });
}

export function recordDurableWakeForSubagentParentBindingMissing(params: {
  store: DurableRuntimeStore;
  childRun: DurableRuntimeRun;
  requesterSessionKey?: string;
  requesterRunId?: string;
  reason: string;
  candidateCount: number;
  now?: number;
}): DurableWake {
  return recordDurableWakeObligation({
    store: params.store,
    reason: "no_handler",
    dedupeKey: `wake:v1:subagent-parent-binding-missing:${params.childRun.runtimeRunId}`,
    sourceRunId: params.childRun.runtimeRunId,
    factsRef: `run:${params.childRun.runtimeRunId}:subagent.parent.binding_missing`,
    facts: {
      sourceRunId: params.childRun.runtimeRunId,
      explicitWorkOwners: [missingAgentSessionCandidate(params.requesterSessionKey)].filter(
        (candidate): candidate is DurableWakeTargetCandidate => Boolean(candidate),
      ),
    },
    evidence: {
      kind: "subagent_parent_binding_missing",
      requesterSessionKey: params.requesterSessionKey,
      requesterRunId: params.requesterRunId,
      reason: params.reason,
      candidateCount: params.candidateCount,
    },
    now: params.now,
  });
}

export function recordDurableWakeForChildTerminalFact(params: {
  store: DurableRuntimeStore;
  parentRun: DurableRuntimeRun;
  childRun: DurableRuntimeRun;
  link: DurableRuntimeLink;
  terminalOutcome: string;
  childSessionKey?: string;
  agentInvocationId?: string;
  error?: string;
  summary?: string;
  recoveryReason?: string;
  now?: number;
}): DurableWake {
  const parentCandidate = durableWakeTargetCandidateFromRun(params.parentRun);
  const reportRoute = durableWakeReportRouteCandidateFromRun(params.parentRun);
  return recordDurableWakeObligation({
    store: params.store,
    reason: "child_terminal",
    dedupeKey: `wake:v1:child-terminal:${params.parentRun.runtimeRunId}:${params.link.parentStepId}:${params.childRun.runtimeRunId}`,
    sourceRunId: params.childRun.runtimeRunId,
    factsRef: `run:${params.parentRun.runtimeRunId}:child:${params.childRun.runtimeRunId}:terminal`,
    facts: {
      sourceRunId: params.childRun.runtimeRunId,
      delegations: [
        {
          kind: "subagent_child",
          parent: parentCandidate,
          reportRoute,
        },
      ],
      reportRoute,
    },
    evidence: {
      kind: "subagent_child_terminal",
      parentRuntimeRunId: params.parentRun.runtimeRunId,
      parentStepId: params.link.parentStepId,
      childRuntimeRunId: params.childRun.runtimeRunId,
      childSessionKey: params.childSessionKey,
      agentInvocationId: params.agentInvocationId,
      terminalOutcome: params.terminalOutcome,
      recoveryReason: params.recoveryReason,
      error: params.error,
      summary: params.summary,
    },
    now: params.now,
  });
}

export function recordDurableWakeForDeliveryUnknownFact(params: {
  store: DurableRuntimeStore;
  parentRun: DurableRuntimeRun;
  childRun: DurableRuntimeRun;
  link: DurableRuntimeLink;
  childSessionKey?: string;
  agentInvocationId?: string;
  path?: string;
  error?: string;
  deliveryReason?: string;
  directRuntimeRunId?: string;
  directIdempotencyKey?: string;
  now?: number;
}): DurableWake {
  const parentCandidate = durableWakeTargetCandidateFromRun(params.parentRun);
  const reportRoute = durableWakeReportRouteCandidateFromRun(params.parentRun);
  return recordDurableWakeObligation({
    store: params.store,
    reason: "delivery_unknown",
    dedupeKey: `wake:v1:delivery-unknown:${params.parentRun.runtimeRunId}:${params.link.parentStepId}:${params.childRun.runtimeRunId}:${params.path ?? "unknown"}`,
    sourceRunId: params.childRun.runtimeRunId,
    factsRef: `run:${params.parentRun.runtimeRunId}:child:${params.childRun.runtimeRunId}:delivery_unknown`,
    facts: {
      sourceRunId: params.childRun.runtimeRunId,
      delegations: [
        {
          kind: "subagent_child",
          parent: parentCandidate,
          reportRoute,
        },
      ],
      reportRoute,
    },
    evidence: {
      kind: "subagent_announce_delivery_unknown",
      parentRuntimeRunId: params.parentRun.runtimeRunId,
      parentStepId: params.link.parentStepId,
      childRuntimeRunId: params.childRun.runtimeRunId,
      childSessionKey: params.childSessionKey,
      agentInvocationId: params.agentInvocationId,
      path: params.path,
      error: params.error,
      reason: params.deliveryReason,
      directRuntimeRunId: params.directRuntimeRunId,
      directIdempotencyKey: params.directIdempotencyKey,
    },
    now: params.now,
  });
}

export function recordDurableWakeForRuntimeAttentionFact(params: {
  store: DurableRuntimeStore;
  run: DurableRuntimeRun;
  reason: Extract<DurableWakeReason, "no_handler" | "side_effect_uncertain">;
  factKind: "no_handler" | "side_effect_uncertain";
  stepId: string;
  workerId: string;
  eventType: string;
  detail?: Record<string, unknown>;
  now?: number;
}): DurableWake {
  const directTurnOwner = durableWakeTargetCandidateFromRun(params.run);
  const reportRoute = durableWakeReportRouteCandidateFromRun(params.run);
  return recordDurableWakeObligation({
    store: params.store,
    reason: params.reason,
    dedupeKey: `wake:v1:${params.factKind}:${params.run.runtimeRunId}:${params.stepId}`,
    sourceRunId: params.run.runtimeRunId,
    factsRef: `run:${params.run.runtimeRunId}:step:${params.stepId}:${params.eventType}`,
    facts: {
      sourceRunId: params.run.runtimeRunId,
      directTurnOwner,
      reportRoute,
    },
    evidence: {
      kind: params.factKind,
      runtimeRunId: params.run.runtimeRunId,
      stepId: params.stepId,
      workerId: params.workerId,
      eventType: params.eventType,
      ...(params.detail ?? {}),
    },
    now: params.now,
  });
}
