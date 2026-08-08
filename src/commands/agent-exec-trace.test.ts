import type { AiModelTransportEvent } from "@openclaw/ai";
import { describe, expect, it } from "vitest";
import { createCodeModeStats } from "../agents/code-mode-stats.js";
import { bindAgentCommandRunAccounting } from "../agents/command/run-accounting.js";
import type { AgentCommandRunAccountingSnapshot } from "../agents/command/run-accounting.types.js";
import {
  computeFrontierEvidenceDigest,
  type FrontierEvidencePolicy,
} from "../agents/frontier-evidence-policy.js";
import type { FrontierEvidenceSnapshot } from "../agents/frontier-evidence-transport-policy.js";
import { classifyAgentExecResult } from "./agent-exec-result.js";
import { projectAgentExecTrace } from "./agent-exec-trace.js";

const complete = { state: "complete" } as const;

function completeSnapshot(): AgentCommandRunAccountingSnapshot {
  const stats = createCodeModeStats();
  stats.bridgeCalls.search = 1;
  stats.bridgeCalls.call = 1;
  return {
    candidates: {
      total: 1,
      returned: 1,
      threw: 0,
      runtimes: { embedded: 1, cli: 0, native: 0, cloud: 0, unknown: 0 },
      entries: [
        {
          provider: "openai",
          model: "gpt-5.6-sol",
          runtime: "embedded",
          outcome: "returned",
          effectiveModels: {
            entries: [{ provider: "openai", model: "gpt-5.6-sol" }],
            truncated: 0,
          },
        },
      ],
      truncated: 0,
    },
    agentSubmissions: { total: 1, completed: 1, failed: 0 },
    assistantTurns: 2,
    usage: {
      input: 120,
      cacheRead: 80,
      output: 20,
      cacheWrite: 0,
      reasoningTokens: 5,
      total: 145,
    },
    toolSummary: { calls: 2, tools: ["exec"] },
    providerTransport: {
      logicalCalls: {
        total: 2,
        totalKind: "exact",
        outcomeKind: "exact",
        completed: 2,
        failed: 0,
        aborted: 0,
        entries: [
          {
            callId: "private-call-1",
            provider: "openai",
            model: "gpt-5.6-sol",
            api: "openai-responses",
            outcome: "completed",
            cachedInput: { state: "exact", tokens: 0 },
          },
          {
            callId: "private-call-2",
            provider: "openai",
            model: "gpt-5.6-sol",
            api: "openai-responses",
            outcome: "completed",
            cachedInput: { state: "exact", tokens: 80 },
          },
        ],
        entriesTruncated: false,
      },
      attempts: {
        total: 2,
        totalKind: "exact",
        initial: 2,
        retries: 0,
        authRecoveries: 0,
        payloadRecoveries: 0,
        transportFallbacks: 0,
      },
      connections: {
        total: 2,
        totalKind: "exact",
        initial: 2,
        prewarms: 0,
        reconnects: 0,
      },
      fallbacks: {
        total: 0,
        totalKind: "exact",
        unsupported: 0,
        connectionFailures: 0,
        submissionFailures: 0,
        streamFailures: 0,
        policy: 0,
      },
      providerFallbacks: { total: 0, totalKind: "exact", server: 0 },
      zeroSubmissions: { total: 0, totalKind: "exact", failed: 0, aborted: 0 },
      events: {
        total: 4,
        totalKind: "exact",
        entries: [
          transportEvent("attempt", 1, 1, "completed"),
          transportEvent("connection", 1, 1, "completed"),
          transportEvent("attempt", 2, 1, "completed"),
          transportEvent("connection", 2, 1, "completed"),
        ],
        entriesTruncated: false,
      },
    },
    commandExecutionDurationMs: 30,
    coverage: {
      candidates: complete,
      agentSubmissions: complete,
      assistantTurns: complete,
      usage: complete,
      usageBuckets: {
        input: complete,
        output: complete,
        cacheRead: complete,
        cacheWrite: complete,
        reasoningTokens: complete,
        total: complete,
      },
      tools: complete,
      cost: { state: "unavailable", reasons: ["missing_pricing"] },
      agentTime: { state: "unavailable", reasons: ["not_instrumented"] },
      commandExecutionDuration: complete,
      wallLatency: { state: "unavailable", reasons: ["not_instrumented"] },
      providerTransport: complete,
    },
    codeMode: {
      engaged: true,
      stats,
      lifecycle: {
        maxUnresolvedAtExtraction: 0,
        attemptsWithUnresolved: 0,
        finalQuiescence: { state: "quiescent" },
      },
    },
  };
}

function retrySnapshot(): AgentCommandRunAccountingSnapshot {
  const snapshot = completeSnapshot();
  snapshot.providerTransport!.attempts.total = 3;
  snapshot.providerTransport!.attempts.retries = 1;
  snapshot.providerTransport!.events.total = 5;
  snapshot.providerTransport!.events.entries = [
    transportEvent("attempt", 1, 1, "failed"),
    transportEvent("attempt", 1, 2, "completed"),
    transportEvent("connection", 1, 1, "completed"),
    transportEvent("attempt", 2, 1, "completed"),
    transportEvent("connection", 2, 1, "completed"),
  ];
  return snapshot;
}

function transportEvent(
  type: "attempt" | "connection",
  call: number,
  ordinal: number,
  outcome: "completed" | "failed",
  attemptReason?: "initial" | "retry" | "payload_recovery",
): AiModelTransportEvent {
  return {
    eventId: `private-event-${type}-${call}-${ordinal}`,
    callId: `private-call-${call}`,
    provider: "openai",
    model: "gpt-5.6-sol",
    api: "openai-responses",
    type,
    transport: "responses-sdk",
    ordinal,
    reason:
      type === "attempt" ? (attemptReason ?? (ordinal === 1 ? "initial" : "retry")) : "initial",
    outcome,
  };
}

function request(
  requestOrdinal: number,
  payloadVariant: "initial" | "encrypted-content-retry",
  fetchDispatchCount: number,
) {
  return {
    requestOrdinal,
    payloadVariant,
    fetchDispatchCount,
    taskDigest: "c".repeat(64),
    fullInputDigest: "d".repeat(64),
    comparableInputDigest: "f".repeat(64),
    toolSchemaDigest: "e".repeat(64),
  };
}

function validReceipt(): FrontierEvidenceSnapshot {
  const contentDigestKey = "f".repeat(64);
  return {
    version: 1,
    policySha256: "a".repeat(64),
    authBindingId: "b".repeat(32),
    credentialState: "frozen_in_memory",
    promptCacheKeyDigest: "9".repeat(64),
    valid: true,
    logicalCalls: 2,
    requestObservations: 2,
    fetchDispatchObservations: 4,
    payloadVariants: ["initial"],
    callSequences: [
      {
        logicalCallOrdinal: 1,
        logicalCallBindingId: computeFrontierEvidenceDigest(
          contentDigestKey,
          "logical-call",
          "private-call-1",
        ),
        requestCount: 1,
        fetchDispatchCount: 2,
        payloadVariants: ["initial"],
        requests: [request(1, "initial", 2)],
      },
      {
        logicalCallOrdinal: 2,
        logicalCallBindingId: computeFrontierEvidenceDigest(
          contentDigestKey,
          "logical-call",
          "private-call-2",
        ),
        requestCount: 1,
        fetchDispatchCount: 2,
        payloadVariants: ["initial"],
        requests: [request(1, "initial", 2)],
      },
    ],
    mismatchCodes: [],
  };
}

function admittedPolicy(): FrontierEvidencePolicy {
  return {
    policySha256: "a".repeat(64),
    authBindingId: "b".repeat(32),
    credentialState: "frozen_in_memory",
    contentDigestKey: "f".repeat(64),
    provider: "openai",
    model: "gpt-5.6-sol",
    api: "openai-responses",
    expectedMaxRetries: 2,
  } as FrontierEvidencePolicy;
}

function project(
  snapshot = completeSnapshot(),
  receipt: FrontierEvidenceSnapshot[] | undefined = [validReceipt()],
) {
  return projectAgentExecTrace({
    snapshot,
    agentDurationMs: 25,
    codeModeEngaged: true,
    frontierPolicy: admittedPolicy(),
    frontierEvidence: receipt,
    model: "gpt-5.6-sol",
    provider: "openai",
  });
}

describe("agent exec trace", () => {
  it("projects exact metrics without double-counting logical calls or redirect hops", () => {
    const trace = project();
    expect(trace).toBeDefined();
    if (!trace) {
      throw new Error("expected trace");
    }

    expect(trace).toMatchObject({
      schemaVersion: 4,
      route: {
        provider: "openai",
        model: "gpt-5.6-sol",
        api: "openai-responses",
        runtime: "embedded",
      },
      metrics: {
        effectiveTurns: { state: "exact", value: 2 },
        logicalModelCalls: { state: "exact", value: 2 },
        providerAttempts: {
          total: { state: "exact", value: 2 },
          initial: { state: "exact", value: 2 },
          retries: { state: "exact", value: 0 },
        },
        physicalFetchDispatch: { state: "exact", value: 4 },
        outerToolCalls: { state: "exact", value: 2 },
        codeModeBridgeCalls: { state: "exact", value: 2 },
        totalToolOperations: { state: "exact", value: 4 },
        underlyingTotalCalls: { state: "exact", value: 8 },
        tokens: {
          input: { state: "exact", value: 120 },
          cachedInput: { state: "exact", value: 80 },
          firstLogicalCallCachedInput: { state: "exact", value: 0 },
          output: { state: "exact", value: 20 },
          reasoning: { state: "exact", value: 5 },
          total: { state: "exact", value: 145 },
        },
        agentDurationMs: { state: "exact", value: 25 },
        commandExecutionDurationMs: { state: "exact", value: 30 },
      },
      audit: { state: "valid" },
    });
    expect(trace.metrics.underlyingTotalCalls).toEqual({
      state: "exact",
      value:
        (trace.metrics.physicalFetchDispatch as { value: number }).value +
        (trace.metrics.totalToolOperations as { value: number }).value,
    });
    expect((trace.metrics.underlyingTotalCalls as { value: number }).value).not.toBe(2 + 4 + 2 + 4);
  });

  it("projects only sanitized Guard B integrity facts", () => {
    const trace = project();

    expect(trace?.frontierEvidence).toMatchObject({
      receiptCount: 1,
      valid: true,
      logicalCalls: 2,
      requestObservations: 2,
      physicalFetchDispatch: 4,
      callSequences: [
        {
          logicalCallOrdinal: 1,
          requests: [{ requestOrdinal: 1, payloadVariant: "initial", fetchDispatchCount: 2 }],
        },
        {
          logicalCallOrdinal: 2,
          requests: [{ requestOrdinal: 1, payloadVariant: "initial", fetchDispatchCount: 2 }],
        },
      ],
    });
    const serialized = JSON.stringify(trace);
    for (const forbidden of [
      "private-call",
      "policySha256",
      "authBindingId",
      "taskDigest",
      "fullInputDigest",
      "toolSchemaDigest",
      "sessionId",
      "eventId",
      "headers",
      "https://",
      "logicalCallBindingId",
      "prompt",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("projects trace through the result envelope without session identity", () => {
    const result = {
      payloads: [{ text: "done" }],
      meta: {
        durationMs: 25,
        agentMeta: {
          sessionId: "private-session",
          provider: "openai",
          model: "gpt-5.6-sol",
          codeModeEngaged: true,
        },
      },
    };
    bindAgentCommandRunAccounting(result.meta, completeSnapshot());

    const trace = classifyAgentExecResult(result, false, undefined, {
      policy: admittedPolicy(),
      receipts: [validReceipt()],
    }).trace;

    expect(trace?.audit).toEqual({ state: "valid" });
    expect(JSON.stringify(trace)).not.toContain("private-session");
  });

  it("uses cacheRead coverage for cached input tokens", () => {
    const snapshot = completeSnapshot();
    snapshot.coverage.usageBuckets.cacheRead = {
      state: "partial",
      reasons: ["partial_usage"],
    };

    expect(project(snapshot)?.metrics.tokens.cachedInput).toEqual({
      state: "lower_bound",
      value: 80,
      reasons: ["partial_usage"],
    });
    expect(project(snapshot)?.metrics.tokens.input).toEqual({ state: "exact", value: 120 });
  });

  it("keeps retry usage and cache authority lower-bound", () => {
    const trace = project(retrySnapshot());

    expect(trace?.metrics.tokens).toMatchObject({
      input: {
        state: "lower_bound",
        value: 120,
        reasons: ["provider_attempt_usage_unattributed"],
      },
      cachedInput: {
        state: "lower_bound",
        value: 80,
        reasons: ["provider_attempt_usage_unattributed"],
      },
      firstLogicalCallCachedInput: {
        state: "unknown",
        reasons: ["provider_attempt_usage_unattributed"],
      },
      output: {
        state: "lower_bound",
        value: 20,
        reasons: ["provider_attempt_usage_unattributed"],
      },
      total: {
        state: "lower_bound",
        value: 145,
        reasons: ["provider_attempt_usage_unattributed"],
      },
    });
    expect(trace?.audit).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining(["provider_attempt_usage_unattributed"]),
    });
  });

  it("keeps usage exact but first-call cache unknown for reused call ids", () => {
    const snapshot = completeSnapshot();
    const reusedCallId = snapshot.providerTransport!.logicalCalls.entries[0]!.callId;
    snapshot.providerTransport!.logicalCalls.entries[1]!.callId = reusedCallId;
    for (const event of snapshot.providerTransport!.events.entries) {
      event.callId = reusedCallId;
    }

    expect(project(snapshot)?.metrics.tokens).toMatchObject({
      input: { state: "exact", value: 120 },
      cachedInput: { state: "exact", value: 80 },
      firstLogicalCallCachedInput: {
        state: "unknown",
        reasons: ["provider_attempt_usage_unattributed"],
      },
      output: { state: "exact", value: 20 },
      total: { state: "exact", value: 145 },
    });
  });

  it("does not assert retry usage from an incomplete transport ledger", () => {
    const snapshot = retrySnapshot();
    snapshot.providerTransport!.attempts.totalKind = "lower_bound";
    snapshot.providerTransport!.events.totalKind = "lower_bound";
    snapshot.providerTransport!.events.entriesTruncated = true;

    expect(project(snapshot)?.metrics.tokens).toMatchObject({
      input: { state: "exact", value: 120 },
      cachedInput: { state: "exact", value: 80 },
      firstLogicalCallCachedInput: {
        state: "unknown",
        reasons: ["provider_attempt_usage_unattributed"],
      },
      output: { state: "exact", value: 20 },
      total: { state: "exact", value: 145 },
    });
  });

  it("keeps tool and derived totals lower-bound until Code Mode is quiescent", () => {
    const snapshot = completeSnapshot();
    snapshot.codeMode!.lifecycle.finalQuiescence = { state: "non_quiescent" };
    snapshot.codeMode!.lifecycle.attemptsWithUnresolved = 1;

    expect(project(snapshot)?.metrics).toMatchObject({
      codeModeBridgeCalls: {
        state: "lower_bound",
        value: 2,
        reasons: ["code_mode_not_quiescent"],
      },
      totalToolOperations: { state: "lower_bound", value: 4 },
      underlyingTotalCalls: { state: "lower_bound", value: 8 },
    });
  });

  it("scopes transport metrics to ledger totals instead of unrelated global coverage", () => {
    const snapshot = completeSnapshot();
    snapshot.coverage.providerTransport = {
      state: "partial",
      reasons: ["transport_outcomes_lower_bound"],
    };

    expect(project(snapshot)?.metrics).toMatchObject({
      logicalModelCalls: { state: "exact", value: 2 },
      providerAttempts: { total: { state: "exact", value: 2 } },
      underlyingTotalCalls: { state: "exact", value: 8 },
    });
    expect(project(snapshot)?.route).toBeDefined();
  });

  it("makes semantic-only transport uncertainty audit-inconclusive", () => {
    const snapshot = completeSnapshot();
    snapshot.coverage.providerTransport = {
      state: "partial",
      reasons: ["transport_terminal_unverified"],
    };
    snapshot.providerTransport!.events.entries.push({
      eventId: "private-event-coverage",
      callId: "private-call-2",
      provider: "openai",
      model: "gpt-5.6-sol",
      api: "openai-responses",
      type: "coverage",
      transport: "responses-sdk",
      scope: "transport_semantics",
      state: "unverified",
      reason: "transport_terminal_unverified",
    });
    snapshot.providerTransport!.events.total += 1;

    expect(project(snapshot)?.audit).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining(["transport_terminal_unverified"]),
    });
  });

  it("keeps provider attempts diagnostic when their ledger is partial", () => {
    const snapshot = completeSnapshot();
    snapshot.providerTransport!.attempts.totalKind = "lower_bound";
    snapshot.coverage.providerTransport = {
      state: "partial",
      reasons: ["transport_totals_lower_bound"],
    };

    expect(project(snapshot)?.metrics).toMatchObject({
      providerAttempts: {
        total: {
          state: "lower_bound",
          value: 2,
          reasons: ["provider_transport_lower_bound"],
        },
      },
      underlyingTotalCalls: {
        state: "lower_bound",
        value: 4,
      },
    });
  });

  it("preserves lower-bound and unavailable propagation for physical work", () => {
    const toolsUnavailable = completeSnapshot();
    toolsUnavailable.toolSummary = undefined;
    toolsUnavailable.codeMode = undefined;

    expect(project(toolsUnavailable)?.metrics).toMatchObject({
      totalToolOperations: {
        state: "unavailable",
        reasons: ["not_observed"],
      },
      underlyingTotalCalls: {
        state: "lower_bound",
        value: 4,
        reasons: ["not_observed"],
      },
    });

    const invalidReceipt = validReceipt();
    invalidReceipt.callSequences[0]!.requests[0]!.requestOrdinal = 2;
    expect(project(toolsUnavailable, [invalidReceipt])?.metrics.underlyingTotalCalls).toEqual({
      state: "unavailable",
      reasons: ["frontier_sequence_invalid", "not_observed"],
    });
  });

  it("uses the ordered first logical call as cold-cache authority", () => {
    const laterCacheHit = completeSnapshot();
    laterCacheHit.providerTransport!.logicalCalls.entries[1]!.cachedInput = {
      state: "exact",
      tokens: 80,
    };
    expect(project(laterCacheHit)?.metrics.tokens).toMatchObject({
      cachedInput: { state: "exact", value: 80 },
      firstLogicalCallCachedInput: { state: "exact", value: 0 },
    });
    const warmFirst = completeSnapshot();
    warmFirst.providerTransport!.logicalCalls.entries[0]!.cachedInput = {
      state: "exact",
      tokens: 12,
    };
    expect(project(warmFirst)?.metrics.tokens.firstLogicalCallCachedInput).toEqual({
      state: "exact",
      value: 12,
    });

    const unknownFirst = completeSnapshot();
    unknownFirst.providerTransport!.logicalCalls.entries[0]!.cachedInput = { state: "unknown" };
    expect(project(unknownFirst)?.metrics.tokens.firstLogicalCallCachedInput).toEqual({
      state: "unknown",
      reasons: ["first_logical_call_cached_input_unknown"],
    });
    expect(project(unknownFirst)?.audit).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining(["first_logical_call_cached_input_unknown"]),
    });

    const unprovenOrder = completeSnapshot();
    unprovenOrder.providerTransport!.logicalCalls.entriesTruncated = true;
    expect(project(unprovenOrder)?.metrics.tokens.firstLogicalCallCachedInput).toEqual({
      state: "unknown",
      reasons: ["first_logical_call_order_unproven"],
    });
  });

  it("rejects accounting conservation failures", () => {
    const snapshot = completeSnapshot();
    snapshot.providerTransport!.attempts.total = 4;
    snapshot.providerTransport!.logicalCalls.completed = 1;

    expect(project(snapshot)?.audit).toEqual({
      state: "inconclusive",
      reasons: expect.arrayContaining([
        "logical_outcome_conservation_mismatch",
        "provider_attempt_conservation_mismatch",
      ]),
    });
  });

  it("reconciles logical outcome entries with aggregate buckets", () => {
    const snapshot = completeSnapshot();
    snapshot.providerTransport!.logicalCalls.entries[0]!.outcome = "failed";

    expect(project(snapshot)?.audit).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining(["logical_outcome_conservation_mismatch"]),
    });
  });

  it("rejects route drift and missing or duplicate receipts", () => {
    const routeDrift = completeSnapshot();
    routeDrift.providerTransport!.logicalCalls.entries[1]!.api = "openai-chat-completions";
    expect(project(routeDrift)?.audit).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining(["route_provenance_incomplete"]),
    });
    expect(
      projectAgentExecTrace({
        snapshot: completeSnapshot(),
        agentDurationMs: 25,
        codeModeEngaged: true,
        frontierPolicy: admittedPolicy(),
        model: "gpt-5.6-sol",
        provider: "openai",
      }),
    ).toBeUndefined();
    expect(project(completeSnapshot(), [validReceipt(), validReceipt()])?.audit).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining(["frontier_receipt_count_mismatch"]),
    });
  });

  it("rejects non-contiguous sequences and cross-layer payload recovery drift", () => {
    const nonContiguous = validReceipt();
    nonContiguous.callSequences[0]!.requests[0]!.requestOrdinal = 2;
    const invalidTrace = project(completeSnapshot(), [nonContiguous]);
    expect(invalidTrace?.metrics.physicalFetchDispatch).toEqual({
      state: "unavailable",
      reasons: ["frontier_sequence_invalid"],
    });
    expect(invalidTrace?.metrics.underlyingTotalCalls).toEqual({
      state: "lower_bound",
      value: 4,
      reasons: ["frontier_sequence_invalid"],
    });
    expect(invalidTrace?.audit).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining(["frontier_sequence_invalid"]),
    });

    const recovery = validReceipt();
    recovery.requestObservations = 3;
    recovery.fetchDispatchObservations = 5;
    recovery.payloadVariants = ["encrypted-content-retry", "initial"];
    recovery.callSequences[0] = {
      ...recovery.callSequences[0]!,
      logicalCallOrdinal: 1,
      requestCount: 2,
      fetchDispatchCount: 3,
      payloadVariants: ["initial", "encrypted-content-retry"],
      requests: [request(1, "initial", 2), request(2, "encrypted-content-retry", 1)],
    };
    const recoveryTrace = project(completeSnapshot(), [recovery]);
    expect(recoveryTrace?.metrics.physicalFetchDispatch).toEqual({
      state: "unavailable",
      reasons: ["cross_layer_call_order_mismatch", "cross_layer_order_mismatch"],
    });
    expect(recoveryTrace?.audit).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining(["cross_layer_order_mismatch"]),
    });
  });

  it("rejects more provider attempts than the frozen retry policy permits", () => {
    const snapshot = retrySnapshot();
    const attempts = snapshot.providerTransport!.events.entries;
    attempts[1] = transportEvent("attempt", 1, 2, "failed");
    attempts.splice(
      2,
      0,
      transportEvent("attempt", 1, 3, "failed"),
      transportEvent("attempt", 1, 4, "completed"),
    );
    snapshot.providerTransport!.attempts.total = 5;
    snapshot.providerTransport!.attempts.retries = 3;
    snapshot.providerTransport!.events.total = 7;
    const receipt = validReceipt();
    receipt.fetchDispatchObservations = 6;
    receipt.callSequences[0]!.fetchDispatchCount = 4;
    receipt.callSequences[0]!.requests[0]!.fetchDispatchCount = 4;

    expect(project(snapshot, [receipt])?.audit).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining(["cross_layer_call_order_mismatch"]),
    });
  });

  it("withholds exact physical dispatch authority from incomplete or foreign provider ledgers", () => {
    const missingDispatches = validReceipt();
    missingDispatches.fetchDispatchObservations = 2;
    missingDispatches.callSequences[0]!.fetchDispatchCount = 1;
    missingDispatches.callSequences[0]!.requests[0]!.fetchDispatchCount = 1;
    missingDispatches.callSequences[1]!.fetchDispatchCount = 1;
    missingDispatches.callSequences[1]!.requests[0]!.fetchDispatchCount = 1;
    expect(project(retrySnapshot(), [missingDispatches])?.metrics.physicalFetchDispatch).toEqual({
      state: "unavailable",
      reasons: ["cross_layer_call_order_mismatch", "cross_layer_order_mismatch"],
    });

    const excessDispatches = validReceipt();
    excessDispatches.fetchDispatchObservations = 17;
    excessDispatches.callSequences[0]!.fetchDispatchCount = 5;
    excessDispatches.callSequences[0]!.requests[0]!.fetchDispatchCount = 5;
    expect(project(completeSnapshot(), [excessDispatches])?.metrics.physicalFetchDispatch).toEqual({
      state: "unavailable",
      reasons: expect.arrayContaining(["cross_layer_order_mismatch", "frontier_sequence_invalid"]),
    });

    const foreignAttempt = completeSnapshot();
    const event = foreignAttempt.providerTransport!.events.entries[0];
    if (event?.type !== "attempt") {
      throw new Error("expected attempt event");
    }
    event.callId = "private-foreign-call";
    const trace = project(foreignAttempt);
    expect(trace?.metrics.physicalFetchDispatch).toEqual({
      state: "unavailable",
      reasons: ["cross_layer_call_order_mismatch", "cross_layer_ledger_mismatch"],
    });
    expect(trace?.audit).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining([
        "cross_layer_call_order_mismatch",
        "cross_layer_ledger_mismatch",
      ]),
    });

    const foreignConnection = completeSnapshot();
    const connectionEvent = foreignConnection.providerTransport!.events.entries[1];
    if (connectionEvent?.type !== "connection" || connectionEvent.reason === "prewarm") {
      throw new Error("expected call-scoped connection event");
    }
    connectionEvent.callId = "private-foreign-call";
    expect(project(foreignConnection)?.metrics.physicalFetchDispatch).toEqual({
      state: "unavailable",
      reasons: ["cross_layer_ledger_mismatch"],
    });

    const foreignTransport = completeSnapshot();
    const transportAttempt = foreignTransport.providerTransport!.events.entries[0];
    if (transportAttempt?.type !== "attempt") {
      throw new Error("expected attempt event");
    }
    transportAttempt.transport = "responses-native";
    expect(project(foreignTransport)?.metrics.physicalFetchDispatch).toEqual({
      state: "unavailable",
      reasons: ["cross_layer_ledger_mismatch"],
    });

    const partialLogicalLedger = completeSnapshot();
    partialLogicalLedger.providerTransport!.logicalCalls.totalKind = "lower_bound";
    expect(project(partialLogicalLedger)?.metrics.physicalFetchDispatch).toEqual({
      state: "unavailable",
      reasons: ["cross_layer_ledger_mismatch"],
    });

    const partialEventLedger = completeSnapshot();
    partialEventLedger.providerTransport!.events.total += 1;
    expect(project(partialEventLedger)?.metrics.physicalFetchDispatch).toEqual({
      state: "unavailable",
      reasons: ["cross_layer_ledger_mismatch"],
    });

    const mixedRoute = completeSnapshot();
    mixedRoute.providerTransport!.logicalCalls.entries[0]!.model = "gpt-5.6-terra";
    const mixedRouteAttempt = mixedRoute.providerTransport!.events.entries[0];
    if (mixedRouteAttempt?.type !== "attempt") {
      throw new Error("expected attempt event");
    }
    mixedRouteAttempt.model = "gpt-5.6-terra";
    expect(project(mixedRoute)?.metrics.physicalFetchDispatch).toEqual({
      state: "unavailable",
      reasons: ["cross_layer_ledger_mismatch"],
    });
  });

  it("rejects policy-binding drift and invalid per-call request counts", () => {
    const bindingDrift = validReceipt();
    bindingDrift.authBindingId = "f".repeat(32);
    expect(project(completeSnapshot(), [bindingDrift])?.audit).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining(["frontier_policy_binding_mismatch"]),
    });

    const zeroRequest = validReceipt();
    zeroRequest.callSequences[0] = {
      ...zeroRequest.callSequences[0]!,
      logicalCallOrdinal: 1,
      requestCount: 0,
      fetchDispatchCount: 0,
      payloadVariants: [],
      requests: [],
    };
    expect(project(completeSnapshot(), [zeroRequest])?.audit).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining(["frontier_sequence_invalid"]),
    });

    const repeatedRecovery = validReceipt();
    repeatedRecovery.callSequences[0] = {
      ...repeatedRecovery.callSequences[0]!,
      logicalCallOrdinal: 1,
      requestCount: 3,
      fetchDispatchCount: 3,
      payloadVariants: ["initial", "encrypted-content-retry", "encrypted-content-retry"],
      requests: [
        request(1, "initial", 1),
        request(2, "encrypted-content-retry", 1),
        request(3, "encrypted-content-retry", 1),
      ],
    };
    expect(project(completeSnapshot(), [repeatedRecovery])?.audit).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining(["frontier_sequence_invalid"]),
    });
  });

  it("rejects route-policy, event-ledger, fallback, and serving-model drift", () => {
    const policyRoute = admittedPolicy();
    policyRoute.model = "gpt-5.6-terra";
    expect(
      projectAgentExecTrace({
        snapshot: completeSnapshot(),
        agentDurationMs: 25,
        codeModeEngaged: true,
        frontierPolicy: policyRoute,
        frontierEvidence: [validReceipt()],
        model: "gpt-5.6-sol",
        provider: "openai",
      })?.audit,
    ).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining(["frontier_policy_route_mismatch"]),
    });

    const snapshot = completeSnapshot();
    snapshot.providerTransport!.events.total = 6;
    snapshot.providerTransport!.events.entriesTruncated = true;
    snapshot.providerTransport!.attempts.transportFallbacks = 1;
    snapshot.providerTransport!.attempts.total = 4;
    snapshot.providerTransport!.fallbacks.total = 1;
    snapshot.providerTransport!.fallbacks.policy = 1;
    snapshot.providerTransport!.providerFallbacks.total = 1;
    snapshot.providerTransport!.providerFallbacks.server = 1;
    snapshot.providerTransport!.zeroSubmissions.total = 1;
    snapshot.providerTransport!.zeroSubmissions.failed = 1;
    snapshot.providerTransport!.logicalCalls.entries[0]!.servingModel = "gpt-5.6-terra";
    expect(project(snapshot)?.audit).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining([
        "provider_fallback_observed",
        "provider_ledger_conservation_mismatch",
        "provider_ledger_incomplete",
        "serving_model_drift",
        "transport_fallback_observed",
        "zero_submission_observed",
      ]),
    });
  });

  it("requires exact provider-ledger kinds and conserved event totals", () => {
    const snapshot = completeSnapshot();
    snapshot.providerTransport!.fallbacks.totalKind = "lower_bound";
    snapshot.providerTransport!.events.total = 4;
    snapshot.providerTransport!.events.entries.pop();
    snapshot.providerTransport!.connections.initial = 1;

    const audit = project(snapshot)?.audit;
    expect(audit).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining([
        "provider_ledger_conservation_mismatch",
        "provider_ledger_incomplete",
      ]),
    });
    if (audit?.state === "inconclusive") {
      expect(audit.reasons).toEqual(audit.reasons.toSorted());
    }
  });

  it("reconciles event reason buckets and per-call recovery order", () => {
    const bucketDrift = retrySnapshot();
    const retryEvent = bucketDrift.providerTransport!.events.entries[1]!;
    if (retryEvent.type !== "attempt") {
      throw new Error("expected attempt event");
    }
    retryEvent.reason = "payload_recovery";
    expect(project(bucketDrift)?.audit).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining(["provider_ledger_bucket_mismatch"]),
    });

    const callDrift = retrySnapshot();
    callDrift.providerTransport!.attempts.retries = 0;
    callDrift.providerTransport!.attempts.payloadRecoveries = 1;
    callDrift.providerTransport!.events.entries[1] = transportEvent(
      "attempt",
      1,
      2,
      "completed",
      "payload_recovery",
    );
    const receipt = validReceipt();
    receipt.requestObservations = 3;
    receipt.payloadVariants = ["encrypted-content-retry", "initial"];
    receipt.callSequences[1] = {
      ...receipt.callSequences[1]!,
      logicalCallOrdinal: 2,
      requestCount: 2,
      fetchDispatchCount: 2,
      payloadVariants: ["initial", "encrypted-content-retry"],
      requests: [request(1, "initial", 1), request(2, "encrypted-content-retry", 1)],
    };
    expect(project(callDrift, [receipt])?.audit).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining(["cross_layer_call_order_mismatch"]),
    });

    const swappedPhaseAllocation = retrySnapshot();
    swappedPhaseAllocation.providerTransport!.attempts.total = 4;
    swappedPhaseAllocation.providerTransport!.attempts.payloadRecoveries = 1;
    swappedPhaseAllocation.providerTransport!.events.total = 6;
    swappedPhaseAllocation.providerTransport!.events.entries = [
      transportEvent("attempt", 1, 1, "failed"),
      transportEvent("attempt", 1, 2, "failed", "retry"),
      transportEvent("attempt", 1, 3, "completed", "payload_recovery"),
      transportEvent("connection", 1, 1, "completed"),
      transportEvent("attempt", 2, 1, "completed"),
      transportEvent("connection", 2, 1, "completed"),
    ];
    const swappedReceipt = validReceipt();
    swappedReceipt.requestObservations = 3;
    swappedReceipt.fetchDispatchObservations = 4;
    swappedReceipt.payloadVariants = ["encrypted-content-retry", "initial"];
    swappedReceipt.callSequences[0] = {
      ...swappedReceipt.callSequences[0]!,
      requestCount: 2,
      fetchDispatchCount: 3,
      payloadVariants: ["initial", "encrypted-content-retry"],
      requests: [request(1, "initial", 1), request(2, "encrypted-content-retry", 2)],
    };
    expect(project(swappedPhaseAllocation, [swappedReceipt])?.audit).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining(["cross_layer_call_order_mismatch"]),
    });
  });

  it("binds the raw receipt to the exact provider ledger and order", () => {
    const wrongLedger = validReceipt();
    wrongLedger.callSequences[0]!.logicalCallBindingId = computeFrontierEvidenceDigest(
      admittedPolicy().contentDigestKey,
      "logical-call",
      "other-run-call-1",
    );
    expect(project(completeSnapshot(), [wrongLedger])?.audit).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining(["cross_layer_ledger_mismatch"]),
    });

    const reordered = validReceipt();
    [
      reordered.callSequences[0]!.logicalCallBindingId,
      reordered.callSequences[1]!.logicalCallBindingId,
    ] = [
      reordered.callSequences[1]!.logicalCallBindingId,
      reordered.callSequences[0]!.logicalCallBindingId,
    ];
    expect(project(completeSnapshot(), [reordered])?.audit).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining(["cross_layer_call_order_mismatch"]),
    });

    const duplicate = validReceipt();
    duplicate.callSequences[1]!.logicalCallBindingId =
      duplicate.callSequences[0]!.logicalCallBindingId;
    expect(project(completeSnapshot(), [duplicate])?.audit).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining(["cross_layer_ledger_mismatch", "frontier_sequence_invalid"]),
    });
  });

  it("omits trace outside admitted frontier runs and lowers ambiguous agent duration", () => {
    const result = {
      payloads: [{ text: "done" }],
      meta: {
        durationMs: 25,
        agentMeta: {
          provider: "openai",
          model: "gpt-5.6-sol",
          codeModeEngaged: true,
        },
      },
    };
    bindAgentCommandRunAccounting(result.meta, completeSnapshot());
    expect(classifyAgentExecResult(result).trace).toBeUndefined();

    const snapshot = completeSnapshot();
    snapshot.candidates.total = 2;
    snapshot.candidates.returned = 1;
    snapshot.candidates.threw = 1;
    expect(project(snapshot)?.metrics.agentDurationMs).toEqual({
      state: "lower_bound",
      value: 25,
      reasons: ["candidate_scope_incomplete"],
    });
  });
});
