import type { AgentCommandRunAccountingSnapshot } from "../agents/command/run-accounting.types.js";
import {
  computeFrontierEvidenceDigest,
  type FrontierEvidencePolicy,
} from "../agents/frontier-evidence-policy.js";
import {
  FRONTIER_EVIDENCE_MAX_FETCH_DISPATCHES_PER_LOGICAL_CALL,
  type FrontierEvidenceSnapshot,
} from "../agents/frontier-evidence-transport-policy.js";
import { DEFAULT_FETCH_GUARD_MAX_REDIRECTS } from "../infra/net/fetch-guard.js";
import {
  agentDurationMetric,
  codeModeBridgeMetric,
  combineMetrics,
  directMetric,
  firstLogicalCallCachedInputMetric,
  observedMetric,
  providerAttemptUsageReasons,
  transportMetric,
  unavailable,
  type AgentExecTraceCacheObservation,
  type AgentExecTraceMetric,
  type AgentExecSanitizedFrontierReceipt,
} from "./agent-exec-trace-metrics.js";

const AGENT_EXEC_TRACE_SCHEMA_VERSION = 4 as const;

const ATTEMPT_BUCKET = {
  initial: "initial",
  retry: "retries",
  auth_recovery: "authRecoveries",
  payload_recovery: "payloadRecoveries",
  transport_fallback: "transportFallbacks",
} as const;
const CONNECTION_BUCKET = {
  initial: "initial",
  prewarm: "prewarms",
  reconnect: "reconnects",
} as const;
const FALLBACK_BUCKET = {
  unsupported: "unsupported",
  connection_failure: "connectionFailures",
  submission_failure: "submissionFailures",
  stream_failure: "streamFailures",
  policy: "policy",
} as const;
const MAX_FRONTIER_FETCH_DISPATCHES_PER_ATTEMPT = DEFAULT_FETCH_GUARD_MAX_REDIRECTS + 1;

export type AgentExecTrace = {
  schemaVersion: typeof AGENT_EXEC_TRACE_SCHEMA_VERSION;
  source: "agent-command-accounting";
  route?: { provider: string; model: string; api: string; runtime: "embedded" };
  frontierEvidence?: AgentExecSanitizedFrontierReceipt;
  metrics: {
    effectiveTurns: AgentExecTraceMetric;
    logicalModelCalls: AgentExecTraceMetric;
    providerAttempts: {
      total: AgentExecTraceMetric;
      initial: AgentExecTraceMetric;
      retries: AgentExecTraceMetric;
      authRecoveries: AgentExecTraceMetric;
      payloadRecoveries: AgentExecTraceMetric;
      transportFallbacks: AgentExecTraceMetric;
    };
    physicalFetchDispatch: AgentExecTraceMetric;
    outerToolCalls: AgentExecTraceMetric;
    codeModeBridgeCalls: AgentExecTraceMetric;
    totalToolOperations: AgentExecTraceMetric;
    underlyingTotalCalls: AgentExecTraceMetric;
    tokens: {
      input: AgentExecTraceMetric;
      cachedInput: AgentExecTraceMetric;
      firstLogicalCallCachedInput: AgentExecTraceCacheObservation;
      output: AgentExecTraceMetric;
      reasoning: AgentExecTraceMetric;
      total: AgentExecTraceMetric;
    };
    agentDurationMs: AgentExecTraceMetric;
    commandExecutionDurationMs: AgentExecTraceMetric;
  };
  audit:
    | { state: "valid" }
    | {
        state: "inconclusive";
        reasons: string[];
      };
};

function projectRoute(snapshot: AgentCommandRunAccountingSnapshot): AgentExecTrace["route"] {
  const [candidate] = snapshot.candidates.entries;
  const [effectiveModel] = candidate?.effectiveModels.entries ?? [];
  const transport = snapshot.providerTransport;
  const [firstCall] = transport?.logicalCalls.entries ?? [];
  if (
    snapshot.coverage.candidates.state !== "complete" ||
    snapshot.candidates.total !== 1 ||
    snapshot.candidates.returned !== 1 ||
    snapshot.candidates.threw !== 0 ||
    snapshot.candidates.truncated !== 0 ||
    snapshot.candidates.entries.length !== 1 ||
    !candidate ||
    candidate.runtime !== "embedded" ||
    candidate.outcome !== "returned" ||
    candidate.effectiveModels.truncated !== 0 ||
    candidate.effectiveModels.entries.length !== 1 ||
    !effectiveModel ||
    effectiveModel.provider !== candidate.provider ||
    effectiveModel.model !== candidate.model ||
    !transport ||
    transport.logicalCalls.totalKind !== "exact" ||
    transport.logicalCalls.outcomeKind !== "exact" ||
    transport.logicalCalls.entriesTruncated ||
    transport.logicalCalls.total < 1 ||
    transport.logicalCalls.entries.length !== transport.logicalCalls.total ||
    !firstCall ||
    transport.logicalCalls.entries.some(
      (call) =>
        call.outcome === undefined ||
        call.provider !== firstCall.provider ||
        call.model !== firstCall.model ||
        call.api !== firstCall.api,
    ) ||
    firstCall.provider !== candidate.provider ||
    firstCall.model !== candidate.model
  ) {
    return undefined;
  }
  return {
    provider: candidate.provider,
    model: candidate.model,
    api: firstCall.api,
    runtime: "embedded",
  };
}

function projectFrontierReceipt(
  receipts: readonly FrontierEvidenceSnapshot[] | undefined,
): AgentExecSanitizedFrontierReceipt | undefined {
  if (receipts?.length !== 1 || !receipts[0]) {
    return undefined;
  }
  const receipt = receipts[0];
  return {
    receiptCount: 1,
    valid: receipt.valid,
    logicalCalls: receipt.logicalCalls,
    requestObservations: receipt.requestObservations,
    physicalFetchDispatch: receipt.fetchDispatchObservations,
    payloadVariants: [...receipt.payloadVariants],
    callSequences: receipt.callSequences.map((sequence) => ({
      logicalCallOrdinal: sequence.logicalCallOrdinal,
      requestCount: sequence.requestCount,
      fetchDispatchCount: sequence.fetchDispatchCount,
      payloadVariants: [...sequence.payloadVariants],
      requests: sequence.requests.map((request) => ({
        requestOrdinal: request.requestOrdinal,
        payloadVariant: request.payloadVariant,
        fetchDispatchCount: request.fetchDispatchCount,
      })),
    })),
  };
}

function receiptIntegrityReasons(receipt: FrontierEvidenceSnapshot): string[] {
  const reasons = new Set<string>();
  if (!receipt.valid || receipt.truncated || receipt.mismatchCodes.length > 0) {
    reasons.add("frontier_receipt_invalid");
  }
  if (
    receipt.logicalCalls < 1 ||
    receipt.callSequences.length !== receipt.logicalCalls ||
    receipt.requestObservations < receipt.logicalCalls ||
    receipt.fetchDispatchObservations < receipt.requestObservations
  ) {
    reasons.add("frontier_sequence_invalid");
  }
  let requestObservations = 0;
  let fetchDispatchObservations = 0;
  const payloadVariants = new Set<"initial" | "encrypted-content-retry">();
  const logicalCallBindingIds = new Set<string>();
  for (const [callIndex, sequence] of receipt.callSequences.entries()) {
    if (
      sequence.logicalCallOrdinal !== callIndex + 1 ||
      !/^[a-f0-9]{64}$/u.test(sequence.logicalCallBindingId) ||
      logicalCallBindingIds.has(sequence.logicalCallBindingId) ||
      sequence.requestCount < 1 ||
      sequence.requestCount > 2 ||
      sequence.requestCount !== sequence.requests.length ||
      sequence.fetchDispatchCount !==
        sequence.requests.reduce((total, request) => total + request.fetchDispatchCount, 0) ||
      sequence.fetchDispatchCount > FRONTIER_EVIDENCE_MAX_FETCH_DISPATCHES_PER_LOGICAL_CALL ||
      sequence.payloadVariants.length !== sequence.requests.length
    ) {
      reasons.add("frontier_sequence_invalid");
    }
    logicalCallBindingIds.add(sequence.logicalCallBindingId);
    for (const [requestIndex, request] of sequence.requests.entries()) {
      const expectedVariant = requestIndex === 0 ? "initial" : "encrypted-content-retry";
      if (
        request.requestOrdinal !== requestIndex + 1 ||
        request.payloadVariant !== expectedVariant ||
        sequence.payloadVariants[requestIndex] !== request.payloadVariant ||
        request.fetchDispatchCount < 1
      ) {
        reasons.add("frontier_sequence_invalid");
      }
      payloadVariants.add(request.payloadVariant);
      requestObservations += 1;
      fetchDispatchObservations += request.fetchDispatchCount;
    }
  }
  if (
    requestObservations !== receipt.requestObservations ||
    fetchDispatchObservations !== receipt.fetchDispatchObservations ||
    JSON.stringify([...payloadVariants].toSorted()) !== JSON.stringify(receipt.payloadVariants)
  ) {
    reasons.add("frontier_sequence_invalid");
  }
  return [...reasons];
}

function receiptTransportIntegrityReasons(params: {
  receipt: FrontierEvidenceSnapshot;
  transport: AgentCommandRunAccountingSnapshot["providerTransport"];
  frontierPolicy: FrontierEvidencePolicy;
}): string[] {
  const reasons = new Set<string>();
  const { receipt, transport, frontierPolicy } = params;
  if (
    !transport ||
    transport.logicalCalls.totalKind !== "exact" ||
    transport.logicalCalls.outcomeKind !== "exact" ||
    transport.logicalCalls.entriesTruncated ||
    transport.logicalCalls.entries.length !== transport.logicalCalls.total ||
    transport.attempts.totalKind !== "exact" ||
    transport.events.totalKind !== "exact" ||
    transport.events.entriesTruncated ||
    transport.events.entries.length !== transport.events.total
  ) {
    return ["cross_layer_ledger_mismatch"];
  }
  if (
    receipt.logicalCalls !== transport.logicalCalls.total ||
    receipt.logicalCalls !== transport.attempts.initial ||
    receipt.requestObservations !==
      transport.attempts.initial + transport.attempts.payloadRecoveries ||
    receipt.fetchDispatchObservations < transport.attempts.total ||
    receipt.fetchDispatchObservations >
      transport.attempts.total * MAX_FRONTIER_FETCH_DISPATCHES_PER_ATTEMPT ||
    transport.attempts.authRecoveries !== 0 ||
    transport.attempts.transportFallbacks !== 0 ||
    receipt.callSequences.reduce(
      (count, sequence) =>
        count +
        sequence.requests.filter((request) => request.payloadVariant === "encrypted-content-retry")
          .length,
      0,
    ) !== transport.attempts.payloadRecoveries
  ) {
    reasons.add("cross_layer_order_mismatch");
  }

  const receiptBindingIds = receipt.callSequences.map((sequence) => sequence.logicalCallBindingId);
  const providerBindingIds = transport.logicalCalls.entries.map((call) =>
    computeFrontierEvidenceDigest(frontierPolicy.contentDigestKey, "logical-call", call.callId),
  );
  const receiptBindingSet = new Set(receiptBindingIds);
  const providerBindingSet = new Set(providerBindingIds);
  if (
    receiptBindingSet.size !== receiptBindingIds.length ||
    providerBindingSet.size !== providerBindingIds.length ||
    receiptBindingSet.size !== providerBindingSet.size ||
    [...receiptBindingSet].some((bindingId) => !providerBindingSet.has(bindingId))
  ) {
    reasons.add("cross_layer_ledger_mismatch");
  } else if (
    receiptBindingIds.some((bindingId, index) => bindingId !== providerBindingIds[index])
  ) {
    reasons.add("cross_layer_call_order_mismatch");
  }

  const logicalCallIds = new Set(transport.logicalCalls.entries.map((call) => call.callId));
  const attemptEvents = transport.events.entries.filter((event) => event.type === "attempt");
  const hasForeignEvent = transport.events.entries.some((event) => {
    if (
      event.provider !== frontierPolicy.provider ||
      event.model !== frontierPolicy.model ||
      event.api !== frontierPolicy.api
    ) {
      return true;
    }
    if (event.type === "connection" && event.reason === "prewarm") {
      return false;
    }
    return (
      !logicalCallIds.has(event.callId) ||
      (event.type === "attempt" && event.transport !== "responses-sdk")
    );
  });
  if (
    logicalCallIds.size !== transport.logicalCalls.entries.length ||
    attemptEvents.length !== transport.attempts.total ||
    hasForeignEvent ||
    transport.logicalCalls.entries.some(
      (call) =>
        call.provider !== frontierPolicy.provider ||
        call.model !== frontierPolicy.model ||
        call.api !== frontierPolicy.api,
    ) ||
    attemptEvents.some(
      (attempt) =>
        !logicalCallIds.has(attempt.callId) ||
        attempt.provider !== frontierPolicy.provider ||
        attempt.model !== frontierPolicy.model ||
        attempt.api !== frontierPolicy.api,
    )
  ) {
    reasons.add("cross_layer_ledger_mismatch");
  }
  for (const [callIndex, call] of transport.logicalCalls.entries.entries()) {
    const sequence = receipt.callSequences[callIndex];
    const attempts = attemptEvents.filter((event) => event.callId === call.callId);
    const payloadRecoveries = attempts.filter(
      (attempt) => attempt.reason === "payload_recovery",
    ).length;
    const encryptedRequests =
      sequence?.requests.filter((request) => request.payloadVariant === "encrypted-content-retry")
        .length ?? 0;
    const recoveryAttemptIndex = attempts.findIndex(
      (attempt) => attempt.reason === "payload_recovery",
    );
    const initialRequest = sequence?.requests[0];
    const recoveryRequest = sequence?.requests[1];
    const phaseOrderValid =
      initialRequest?.payloadVariant === "initial" &&
      (recoveryRequest
        ? sequence?.requests.length === 2 &&
          recoveryRequest.payloadVariant === "encrypted-content-retry" &&
          recoveryAttemptIndex > 0 &&
          recoveryAttemptIndex <= frontierPolicy.expectedMaxRetries + 1 &&
          attempts.length - recoveryAttemptIndex <= frontierPolicy.expectedMaxRetries + 1 &&
          attempts.slice(1, recoveryAttemptIndex).every((attempt) => attempt.reason === "retry") &&
          attempts.slice(recoveryAttemptIndex + 1).every((attempt) => attempt.reason === "retry") &&
          initialRequest.fetchDispatchCount >= recoveryAttemptIndex &&
          initialRequest.fetchDispatchCount <=
            recoveryAttemptIndex * MAX_FRONTIER_FETCH_DISPATCHES_PER_ATTEMPT &&
          recoveryRequest.fetchDispatchCount >= attempts.length - recoveryAttemptIndex &&
          recoveryRequest.fetchDispatchCount <=
            (attempts.length - recoveryAttemptIndex) * MAX_FRONTIER_FETCH_DISPATCHES_PER_ATTEMPT
        : recoveryAttemptIndex === -1 &&
          attempts.length <= frontierPolicy.expectedMaxRetries + 1 &&
          attempts.slice(1).every((attempt) => attempt.reason === "retry") &&
          initialRequest.fetchDispatchCount >= attempts.length &&
          initialRequest.fetchDispatchCount <=
            attempts.length * MAX_FRONTIER_FETCH_DISPATCHES_PER_ATTEMPT);
    if (
      !sequence ||
      attempts.length < 1 ||
      attempts.filter((attempt) => attempt.reason === "initial").length !== 1 ||
      attempts[0]?.reason !== "initial" ||
      attempts.some((attempt, attemptIndex) => attempt.ordinal !== attemptIndex + 1) ||
      payloadRecoveries !== encryptedRequests ||
      sequence.fetchDispatchCount < attempts.length ||
      sequence.fetchDispatchCount > attempts.length * MAX_FRONTIER_FETCH_DISPATCHES_PER_ATTEMPT ||
      !phaseOrderValid
    ) {
      reasons.add("cross_layer_call_order_mismatch");
    }
  }
  return [...reasons];
}

function auditTrace(params: {
  snapshot: AgentCommandRunAccountingSnapshot;
  metrics: AgentExecTrace["metrics"];
  route: AgentExecTrace["route"];
  receipts?: readonly FrontierEvidenceSnapshot[];
  frontierPolicy: FrontierEvidencePolicy;
  observedRoute: { model?: string; provider?: string };
}): AgentExecTrace["audit"] {
  const reasons = new Set<string>();
  const { snapshot, metrics, route, receipts, frontierPolicy, observedRoute } = params;
  const requiredMetrics: Array<[string, AgentExecTraceMetric]> = [
    ["effective_turns", metrics.effectiveTurns],
    ["logical_model_calls", metrics.logicalModelCalls],
    ["provider_attempts", metrics.providerAttempts.total],
    ["physical_fetch_dispatch", metrics.physicalFetchDispatch],
    ["outer_tool_calls", metrics.outerToolCalls],
    ["code_mode_bridge_calls", metrics.codeModeBridgeCalls],
    ["total_tool_operations", metrics.totalToolOperations],
    ["underlying_total_calls", metrics.underlyingTotalCalls],
    ["input_tokens", metrics.tokens.input],
    ["cached_input_tokens", metrics.tokens.cachedInput],
    ["output_tokens", metrics.tokens.output],
    ["reasoning_tokens", metrics.tokens.reasoning],
    ["total_tokens", metrics.tokens.total],
    ["agent_duration", metrics.agentDurationMs],
    ["command_execution_duration", metrics.commandExecutionDurationMs],
  ];
  for (const [name, metric] of requiredMetrics) {
    if (metric.state !== "exact") {
      reasons.add(`${name}_${metric.state}`);
    }
  }
  if (metrics.tokens.firstLogicalCallCachedInput.state !== "exact") {
    for (const reason of metrics.tokens.firstLogicalCallCachedInput.reasons) {
      reasons.add(reason);
    }
  }

  if (!route) {
    reasons.add("route_provenance_incomplete");
  } else {
    if (observedRoute.provider !== route.provider || observedRoute.model !== route.model) {
      reasons.add("route_identity_mismatch");
    }
    if (
      route.provider !== frontierPolicy.provider ||
      route.model !== frontierPolicy.model ||
      route.api !== frontierPolicy.api
    ) {
      reasons.add("frontier_policy_route_mismatch");
    }
  }

  const transport = snapshot.providerTransport;
  if (transport) {
    if (snapshot.coverage.providerTransport.state !== "complete") {
      for (const reason of snapshot.coverage.providerTransport.reasons) {
        reasons.add(reason);
      }
    }
    const entryOutcomes = {
      completed: transport.logicalCalls.entries.filter((call) => call.outcome === "completed")
        .length,
      failed: transport.logicalCalls.entries.filter((call) => call.outcome === "failed").length,
      aborted: transport.logicalCalls.entries.filter((call) => call.outcome === "aborted").length,
    };
    if (
      transport.logicalCalls.total !==
        transport.logicalCalls.completed +
          transport.logicalCalls.failed +
          transport.logicalCalls.aborted ||
      transport.logicalCalls.entries.length !== transport.logicalCalls.total ||
      entryOutcomes.completed !== transport.logicalCalls.completed ||
      entryOutcomes.failed !== transport.logicalCalls.failed ||
      entryOutcomes.aborted !== transport.logicalCalls.aborted
    ) {
      reasons.add("logical_outcome_conservation_mismatch");
    }
    if (
      transport.attempts.total !==
      transport.attempts.initial +
        transport.attempts.retries +
        transport.attempts.authRecoveries +
        transport.attempts.payloadRecoveries +
        transport.attempts.transportFallbacks
    ) {
      reasons.add("provider_attempt_conservation_mismatch");
    }
    if (
      transport.connections.totalKind !== "exact" ||
      transport.fallbacks.totalKind !== "exact" ||
      transport.providerFallbacks.totalKind !== "exact" ||
      transport.zeroSubmissions.totalKind !== "exact" ||
      transport.events.totalKind !== "exact" ||
      transport.events.entriesTruncated ||
      transport.events.entries.length !== transport.events.total
    ) {
      reasons.add("provider_ledger_incomplete");
    }
    if (
      transport.events.total !==
      transport.attempts.total +
        transport.connections.total +
        transport.fallbacks.total +
        transport.providerFallbacks.total +
        transport.events.entries.filter((event) => event.type === "coverage").length +
        transport.zeroSubmissions.total
    ) {
      reasons.add("provider_ledger_conservation_mismatch");
    }
    if (
      transport.connections.total !==
        transport.connections.initial +
          transport.connections.prewarms +
          transport.connections.reconnects ||
      transport.fallbacks.total !==
        transport.fallbacks.unsupported +
          transport.fallbacks.connectionFailures +
          transport.fallbacks.submissionFailures +
          transport.fallbacks.streamFailures +
          transport.fallbacks.policy ||
      transport.providerFallbacks.total !== transport.providerFallbacks.server ||
      transport.zeroSubmissions.total !==
        transport.zeroSubmissions.failed + transport.zeroSubmissions.aborted
    ) {
      reasons.add("provider_ledger_conservation_mismatch");
    }
    const eventBuckets = {
      attempts: {
        initial: 0,
        retries: 0,
        authRecoveries: 0,
        payloadRecoveries: 0,
        transportFallbacks: 0,
      },
      connections: { initial: 0, prewarms: 0, reconnects: 0 },
      fallbacks: {
        unsupported: 0,
        connectionFailures: 0,
        submissionFailures: 0,
        streamFailures: 0,
        policy: 0,
      },
      providerFallbacks: 0,
      zeroSubmissions: { failed: 0, aborted: 0 },
    };
    for (const event of transport.events.entries) {
      if (event.type === "attempt") {
        eventBuckets.attempts[ATTEMPT_BUCKET[event.reason]] += 1;
      } else if (event.type === "connection") {
        eventBuckets.connections[CONNECTION_BUCKET[event.reason]] += 1;
      } else if (event.type === "fallback") {
        eventBuckets.fallbacks[FALLBACK_BUCKET[event.reason]] += 1;
      } else if (event.type === "provider_fallback") {
        eventBuckets.providerFallbacks += 1;
      } else if (event.type === "submission") {
        eventBuckets.zeroSubmissions[event.outcome] += 1;
      }
    }
    if (
      eventBuckets.attempts.initial !== transport.attempts.initial ||
      eventBuckets.attempts.retries !== transport.attempts.retries ||
      eventBuckets.attempts.authRecoveries !== transport.attempts.authRecoveries ||
      eventBuckets.attempts.payloadRecoveries !== transport.attempts.payloadRecoveries ||
      eventBuckets.attempts.transportFallbacks !== transport.attempts.transportFallbacks ||
      eventBuckets.connections.initial !== transport.connections.initial ||
      eventBuckets.connections.prewarms !== transport.connections.prewarms ||
      eventBuckets.connections.reconnects !== transport.connections.reconnects ||
      eventBuckets.fallbacks.unsupported !== transport.fallbacks.unsupported ||
      eventBuckets.fallbacks.connectionFailures !== transport.fallbacks.connectionFailures ||
      eventBuckets.fallbacks.submissionFailures !== transport.fallbacks.submissionFailures ||
      eventBuckets.fallbacks.streamFailures !== transport.fallbacks.streamFailures ||
      eventBuckets.fallbacks.policy !== transport.fallbacks.policy ||
      eventBuckets.providerFallbacks !== transport.providerFallbacks.server ||
      eventBuckets.zeroSubmissions.failed !== transport.zeroSubmissions.failed ||
      eventBuckets.zeroSubmissions.aborted !== transport.zeroSubmissions.aborted
    ) {
      reasons.add("provider_ledger_bucket_mismatch");
    }
    if (transport.fallbacks.total > 0 || transport.attempts.transportFallbacks > 0) {
      reasons.add("transport_fallback_observed");
    }
    if (transport.providerFallbacks.total > 0) {
      reasons.add("provider_fallback_observed");
    }
    if (transport.zeroSubmissions.total > 0) {
      reasons.add("zero_submission_observed");
    }
    if (
      route &&
      transport.logicalCalls.entries.some(
        (call) => call.servingModel !== undefined && call.servingModel !== route.model,
      )
    ) {
      reasons.add("serving_model_drift");
    }
  }

  if (receipts?.length !== 1 || !receipts[0]) {
    reasons.add("frontier_receipt_count_mismatch");
  } else {
    const receipt = receipts[0];
    if (
      receipt.policySha256 !== frontierPolicy.policySha256 ||
      receipt.authBindingId !== frontierPolicy.authBindingId ||
      receipt.credentialState !== frontierPolicy.credentialState
    ) {
      reasons.add("frontier_policy_binding_mismatch");
    }
    for (const reason of receiptIntegrityReasons(receipt)) {
      reasons.add(reason);
    }
    for (const reason of receiptTransportIntegrityReasons({
      receipt,
      transport,
      frontierPolicy,
    })) {
      reasons.add(reason);
    }
  }

  return reasons.size === 0
    ? { state: "valid" }
    : { state: "inconclusive", reasons: [...reasons].toSorted() };
}

export function projectAgentExecTrace(params: {
  snapshot: AgentCommandRunAccountingSnapshot | undefined;
  agentDurationMs?: number;
  codeModeEngaged?: boolean;
  frontierPolicy?: FrontierEvidencePolicy;
  frontierEvidence?: readonly FrontierEvidenceSnapshot[];
  model?: string;
  provider?: string;
}): AgentExecTrace | undefined {
  const snapshot = params.snapshot;
  if (!snapshot || !params.frontierPolicy || !params.frontierEvidence?.length) {
    return undefined;
  }
  const transport = snapshot.providerTransport;
  const attemptsKind = transport?.attempts.totalKind;
  const outerToolCalls = observedMetric({
    value: snapshot.toolSummary?.calls,
    coverage: snapshot.coverage.tools,
  });
  const codeModeBridgeCalls = codeModeBridgeMetric(snapshot, params.codeModeEngaged);
  const totalToolOperations = combineMetrics(outerToolCalls, codeModeBridgeCalls);
  const providerAttemptsTotal = transportMetric(transport?.attempts.total, attemptsKind);
  const frontierReceipt = projectFrontierReceipt(params.frontierEvidence);
  const receiptAuthorityReasons =
    params.frontierEvidence.length === 1 && params.frontierEvidence[0]
      ? [
          ...receiptIntegrityReasons(params.frontierEvidence[0]),
          ...receiptTransportIntegrityReasons({
            receipt: params.frontierEvidence[0],
            transport,
            frontierPolicy: params.frontierPolicy,
          }),
          ...(params.frontierEvidence[0].policySha256 !== params.frontierPolicy.policySha256 ||
          params.frontierEvidence[0].authBindingId !== params.frontierPolicy.authBindingId ||
          params.frontierEvidence[0].credentialState !== params.frontierPolicy.credentialState
            ? ["frontier_policy_binding_mismatch"]
            : []),
        ]
      : ["frontier_receipt_count_mismatch"];
  const physicalFetchDispatch = frontierReceipt
    ? receiptAuthorityReasons.length === 0
      ? directMetric(frontierReceipt.physicalFetchDispatch, ["frontier_receipt_invalid"])
      : unavailable(receiptAuthorityReasons)
    : unavailable(["frontier_receipt_unavailable"]);
  const tokenUsageReasons = providerAttemptUsageReasons(snapshot);
  const metrics: AgentExecTrace["metrics"] = {
    effectiveTurns: observedMetric({
      value: snapshot.assistantTurns,
      coverage: snapshot.coverage.assistantTurns,
    }),
    logicalModelCalls: transportMetric(
      transport?.logicalCalls.total,
      transport?.logicalCalls.totalKind,
    ),
    providerAttempts: {
      total: providerAttemptsTotal,
      initial: transportMetric(transport?.attempts.initial, attemptsKind),
      retries: transportMetric(transport?.attempts.retries, attemptsKind),
      authRecoveries: transportMetric(transport?.attempts.authRecoveries, attemptsKind),
      payloadRecoveries: transportMetric(transport?.attempts.payloadRecoveries, attemptsKind),
      transportFallbacks: transportMetric(transport?.attempts.transportFallbacks, attemptsKind),
    },
    physicalFetchDispatch,
    outerToolCalls,
    codeModeBridgeCalls,
    totalToolOperations,
    // Logical model calls and redirect hops are separate observations. Adding
    // either here would double-count work already represented by dispatches.
    underlyingTotalCalls: combineMetrics(physicalFetchDispatch, totalToolOperations),
    tokens: {
      input: observedMetric({
        value: snapshot.usage?.input,
        coverage: snapshot.coverage.usageBuckets.input,
        extraReasons: tokenUsageReasons,
      }),
      cachedInput: observedMetric({
        value: snapshot.usage?.cacheRead,
        coverage: snapshot.coverage.usageBuckets.cacheRead,
        extraReasons: tokenUsageReasons,
      }),
      firstLogicalCallCachedInput: firstLogicalCallCachedInputMetric(snapshot),
      output: observedMetric({
        value: snapshot.usage?.output,
        coverage: snapshot.coverage.usageBuckets.output,
        extraReasons: tokenUsageReasons,
      }),
      reasoning: observedMetric({
        value: snapshot.usage?.reasoningTokens,
        coverage: snapshot.coverage.usageBuckets.reasoningTokens,
        extraReasons: tokenUsageReasons,
      }),
      total: observedMetric({
        value: snapshot.usage?.total,
        coverage: snapshot.coverage.usageBuckets.total,
        extraReasons: tokenUsageReasons,
      }),
    },
    agentDurationMs: agentDurationMetric(snapshot, params.agentDurationMs),
    commandExecutionDurationMs: observedMetric({
      value: snapshot.commandExecutionDurationMs,
      coverage: snapshot.coverage.commandExecutionDuration,
    }),
  };
  const route = projectRoute(snapshot);
  return {
    schemaVersion: AGENT_EXEC_TRACE_SCHEMA_VERSION,
    source: "agent-command-accounting",
    ...(route ? { route } : {}),
    ...(frontierReceipt ? { frontierEvidence: frontierReceipt } : {}),
    metrics,
    audit: auditTrace({
      snapshot,
      metrics,
      route,
      receipts: params.frontierEvidence,
      frontierPolicy: params.frontierPolicy,
      observedRoute: { model: params.model, provider: params.provider },
    }),
  };
}
