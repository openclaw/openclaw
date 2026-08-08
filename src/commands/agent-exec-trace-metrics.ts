import type {
  AgentCommandRunAccountingCoverage,
  AgentCommandRunAccountingSnapshot,
} from "../agents/command/run-accounting.types.js";
import {
  hasUnattributedProviderAttemptUsage,
  resolveExactProviderTransportAttemptCount,
} from "../agents/provider-transport-accounting.js";

export type AgentExecTraceMetric =
  | { state: "exact" | "lower_bound"; value: number; reasons?: string[] }
  | { state: "unavailable"; reasons: string[] };

export type AgentExecTraceCacheObservation =
  | { state: "exact"; value: number }
  | { state: "unknown"; reasons: string[] };

export type AgentExecSanitizedFrontierReceipt = {
  receiptCount: number;
  valid: boolean;
  logicalCalls: number;
  requestObservations: number;
  physicalFetchDispatch: number;
  payloadVariants: Array<"initial" | "encrypted-content-retry">;
  callSequences: Array<{
    logicalCallOrdinal: number;
    requestCount: number;
    fetchDispatchCount: number;
    payloadVariants: Array<"initial" | "encrypted-content-retry">;
    requests: Array<{
      requestOrdinal: number;
      payloadVariant: "initial" | "encrypted-content-retry";
      fetchDispatchCount: number;
    }>;
  }>;
};

function normalizedReasons(reasons: Iterable<string>): string[] {
  return [...new Set(reasons)].toSorted();
}

function coverageReasons(coverage: AgentCommandRunAccountingCoverage): string[] {
  return "reasons" in coverage ? normalizedReasons(coverage.reasons) : [];
}

export function unavailable(reasons: Iterable<string>): AgentExecTraceMetric {
  const normalized = normalizedReasons(reasons);
  return {
    state: "unavailable",
    reasons: normalized.length > 0 ? normalized : ["not_observed"],
  };
}

export function observedMetric(params: {
  value: number | undefined;
  coverage: AgentCommandRunAccountingCoverage;
  lowerBound?: boolean;
  extraReasons?: string[];
}): AgentExecTraceMetric {
  if (
    params.value === undefined ||
    !Number.isFinite(params.value) ||
    !Number.isInteger(params.value) ||
    params.value < 0
  ) {
    return unavailable(coverageReasons(params.coverage));
  }
  const reasons = normalizedReasons([
    ...coverageReasons(params.coverage),
    ...(params.extraReasons ?? []),
  ]);
  if (params.lowerBound === true || params.coverage.state !== "complete" || reasons.length > 0) {
    return {
      state: "lower_bound",
      value: params.value,
      ...(reasons.length > 0 ? { reasons } : {}),
    };
  }
  return { state: "exact", value: params.value };
}

export function providerAttemptUsageReasons(snapshot: AgentCommandRunAccountingSnapshot): string[] {
  return hasUnattributedProviderAttemptUsage(snapshot.providerTransport)
    ? ["provider_attempt_usage_unattributed"]
    : [];
}

export function directMetric(value: number | undefined, reasons: string[]): AgentExecTraceMetric {
  if (value === undefined || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return unavailable(reasons);
  }
  return { state: "exact", value };
}

export function agentDurationMetric(
  snapshot: AgentCommandRunAccountingSnapshot,
  durationMs: number | undefined,
): AgentExecTraceMetric {
  const metric = directMetric(durationMs, ["not_observed"]);
  if (metric.state === "unavailable") {
    return metric;
  }
  const exact =
    snapshot.coverage.candidates.state === "complete" &&
    snapshot.candidates.total === 1 &&
    snapshot.candidates.returned === 1 &&
    snapshot.candidates.threw === 0;
  return exact
    ? metric
    : {
        state: "lower_bound",
        value: metric.value,
        reasons: normalizedReasons([
          ...coverageReasons(snapshot.coverage.candidates),
          "candidate_scope_incomplete",
        ]),
      };
}

export function combineMetrics(...metrics: AgentExecTraceMetric[]): AgentExecTraceMetric {
  const observed = metrics.filter(
    (metric): metric is Extract<AgentExecTraceMetric, { value: number }> => "value" in metric,
  );
  if (observed.length === 0) {
    return unavailable(metrics.flatMap((metric) => metric.reasons ?? []));
  }
  const reasons = normalizedReasons(metrics.flatMap((metric) => metric.reasons ?? []));
  return {
    state: metrics.every((metric) => metric.state === "exact") ? "exact" : "lower_bound",
    value: observed.reduce((total, metric) => total + metric.value, 0),
    ...(reasons.length > 0 ? { reasons } : {}),
  };
}

export function transportMetric(
  value: number | undefined,
  totalKind: "exact" | "lower_bound" | undefined,
): AgentExecTraceMetric {
  if (value === undefined || totalKind === undefined) {
    return unavailable(["provider_transport_not_observed"]);
  }
  const metric = directMetric(value, ["provider_transport_invalid"]);
  if (metric.state === "unavailable" || totalKind === "exact") {
    return metric;
  }
  return {
    state: "lower_bound",
    value: metric.value,
    reasons: ["provider_transport_lower_bound"],
  };
}

export function firstLogicalCallCachedInputMetric(
  snapshot: AgentCommandRunAccountingSnapshot,
): AgentExecTraceCacheObservation {
  const logicalCalls = snapshot.providerTransport?.logicalCalls;
  const [firstCall] = logicalCalls?.entries ?? [];
  if (
    !logicalCalls ||
    logicalCalls.totalKind !== "exact" ||
    logicalCalls.entriesTruncated ||
    logicalCalls.total < 1 ||
    logicalCalls.entries.length !== logicalCalls.total ||
    !firstCall
  ) {
    return { state: "unknown", reasons: ["first_logical_call_order_unproven"] };
  }
  const attemptCount = resolveExactProviderTransportAttemptCount(
    snapshot.providerTransport,
    firstCall.callId,
  );
  if (attemptCount !== 1) {
    return {
      state: "unknown",
      reasons: ["provider_attempt_usage_unattributed"],
    };
  }
  if (
    firstCall.cachedInput.state !== "exact" ||
    !Number.isFinite(firstCall.cachedInput.tokens) ||
    !Number.isInteger(firstCall.cachedInput.tokens) ||
    firstCall.cachedInput.tokens < 0
  ) {
    return {
      state: "unknown",
      reasons: ["first_logical_call_cached_input_unknown"],
    };
  }
  return { state: "exact", value: firstCall.cachedInput.tokens };
}

export function codeModeBridgeMetric(
  snapshot: AgentCommandRunAccountingSnapshot,
  codeModeEngaged: boolean | undefined,
): AgentExecTraceMetric {
  const codeMode = snapshot.codeMode;
  if (!codeMode && codeModeEngaged === false) {
    return { state: "exact", value: 0 };
  }
  if (!codeMode?.stats) {
    return unavailable(["not_observed"]);
  }
  const value = Object.values(codeMode.stats.bridgeCalls).reduce(
    (total, count) => total + (count ?? 0),
    0,
  );
  const lifecycle = codeMode.lifecycle;
  const exact =
    lifecycle.finalQuiescence.state === "quiescent" &&
    lifecycle.attemptsWithUnresolved === 0 &&
    lifecycle.maxUnresolvedAtExtraction === 0;
  if (exact) {
    return { state: "exact", value };
  }
  const reasons =
    "reasons" in lifecycle.finalQuiescence
      ? lifecycle.finalQuiescence.reasons
      : ["code_mode_not_quiescent"];
  return { state: "lower_bound", value, reasons: normalizedReasons(reasons) };
}
