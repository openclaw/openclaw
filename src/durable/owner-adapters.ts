import {
  getSubagentRunFromSqlite,
  listSubagentAttentionCandidatesFromSqlite,
} from "../agents/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../agents/subagent-registry.types.js";
import {
  requestSessionAttentionDelivery,
  type SessionAttentionDeliveryResult,
} from "../sessions/session-attention.js";
import {
  getTaskById,
  listTaskRecords,
  requestTaskAttentionDelivery,
} from "../tasks/runtime-internal.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import { getTaskFlowById, listTaskFlowRecords } from "../tasks/task-flow-runtime-internal.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import type {
  DurableOwnerAdapter,
  DurableOwnerAttentionFact,
  DurableOwnerDispatchResult,
} from "./owner-adapter-contract.js";
import { DURABLE_AGENT_TURN_OPERATION_KIND } from "./runtime-ids.js";
import { sessionStoreOwnerAdapter } from "./session-owner-adapter.js";
import type { DurableRuntimeStore, WakeObligation } from "./types.js";

export type {
  DurableOwnerAdapter,
  DurableOwnerAttentionFact,
  DurableOwnerDispatchResult,
} from "./owner-adapter-contract.js";
export { sessionStoreOwnerAdapter } from "./session-owner-adapter.js";

const SUBAGENT_PROGRESS_SLA_MS = process.env.OPENCLAW_TEST_FAST === "1" ? 1_000 : 120_000;
const TASK_PROGRESS_SLA_MS = process.env.OPENCLAW_TEST_FAST === "1" ? 1_000 : 120_000;
const FLOW_PROGRESS_SLA_MS = process.env.OPENCLAW_TEST_FAST === "1" ? 1_000 : 120_000;

function wakeSourceRevision(wake: WakeObligation): string | undefined {
  const revision = wake.metadata?.sourceRevision;
  return typeof revision === "string" && revision.trim() ? revision : undefined;
}

function sourceRevisionChanged(wake: WakeObligation, currentRevision: string): boolean {
  const expected = wakeSourceRevision(wake);
  return expected !== undefined && expected !== currentRevision;
}

function gateChangedSourceRevision(params: {
  wake: WakeObligation;
  currentRevision: string;
  currentFact: DurableOwnerAttentionFact | undefined;
}): DurableOwnerDispatchResult | undefined {
  if (!sourceRevisionChanged(params.wake, params.currentRevision)) {
    return undefined;
  }
  const evidence = {
    expectedRevision: wakeSourceRevision(params.wake),
    currentRevision: params.currentRevision,
    currentDedupeKey: params.currentFact?.dedupeKey,
  };
  if (!params.currentFact || params.currentFact.dedupeKey !== params.wake.dedupeKey) {
    return {
      kind: "superseded",
      reason: "canonical_attention_fact_changed",
      evidence,
    };
  }
  return {
    kind: "deferred",
    reason: "canonical_source_revision_advanced",
    evidence,
  };
}

async function dispatchDurableProgressFallback(params: {
  wake: WakeObligation;
  claimToken: string;
  canonicalOwner: "subagent_runs" | "task_runs";
}): Promise<DurableOwnerDispatchResult> {
  const sessionDispatch = await sessionStoreOwnerAdapter.dispatchAttention({
    wake: params.wake,
    claimToken: params.claimToken,
  });
  return sessionDispatch.kind === "handoff_accepted"
    ? {
        kind: "handoff_accepted",
        evidence: {
          ...sessionDispatch.evidence,
          canonicalOwner: params.canonicalOwner,
          ownerResult: "durable_progress_fallback",
        },
      }
    : sessionDispatch;
}

function subagentRevision(entry: SubagentRunRecord): string {
  return [
    entry.generation ?? 0,
    entry.execution?.status ?? "unknown",
    entry.execution?.interruptedAt ?? 0,
    entry.endedAt ?? 0,
    entry.delivery?.status ?? "none",
    entry.delivery?.attemptCount ?? 0,
    entry.delivery?.lastAttemptAt ?? 0,
    entry.delivery?.deliveredAt ?? entry.delivery?.announcedAt ?? 0,
    entry.progressNotice?.lastAttemptedAt ?? 0,
    entry.progressNotice?.lastNoticedAt ?? 0,
  ].join(":");
}

function subagentAttentionFact(
  entry: SubagentRunRecord,
  now = Date.now(),
): DurableOwnerAttentionFact | undefined {
  const requesterSessionKey = entry.requesterSessionKey.trim();
  const targetResolved = requesterSessionKey.length > 0;
  const targetRef = targetResolved ? requesterSessionKey : `subagent_runs:${entry.runId}`;
  const base = {
    sourceOwner: "subagent_runs",
    sourceRef: entry.runId,
    sourceRevision: subagentRevision(entry),
    targetKind: targetResolved ? ("agent_session" as const) : ("inspect_only" as const),
    targetRef,
    targetResolutionStatus: targetResolved ? ("resolved" as const) : ("missing" as const),
    targetResolutionReason: targetResolved
      ? "requester session resolved from canonical subagent owner"
      : "canonical subagent owner has no requester session",
    ...(targetResolved
      ? { ownerRef: requesterSessionKey, reportRouteRef: requesterSessionKey }
      : {}),
    ...(entry.requesterRunId ? { requesterRunId: entry.requesterRunId } : {}),
  };

  if (entry.execution?.status === "interrupted") {
    return {
      ...base,
      reason: "restart_interrupted",
      dedupeKey: `subagent-interrupted-wake:${entry.runId}:${targetRef}`,
      metadata: {
        sourceRevision: subagentRevision(entry),
        childSessionKey: entry.childSessionKey,
        interruptionReason: entry.execution.interruptionReason,
        interruptedAt: entry.execution.interruptedAt,
      },
    };
  }

  const progressBoundary = Math.max(
    entry.progressNotice?.lastNoticedAt ?? 0,
    entry.progressNotice?.lastAttemptedAt ?? 0,
    entry.startedAt ?? entry.createdAt,
  );
  if (typeof entry.endedAt !== "number" && now - progressBoundary >= SUBAGENT_PROGRESS_SLA_MS) {
    const checkpoint = Math.floor(now / SUBAGENT_PROGRESS_SLA_MS);
    return {
      ...base,
      reason: "child_overdue",
      dedupeKey: `subagent-progress:${entry.runId}:${checkpoint}`,
      metadata: {
        sourceRevision: subagentRevision(entry),
        childSessionKey: entry.childSessionKey,
        requesterRunId: entry.requesterRunId,
        startedAt: entry.startedAt ?? entry.createdAt,
        lastProgressAttemptAt: entry.progressNotice?.lastAttemptedAt,
        lastProgressNoticedAt: entry.progressNotice?.lastNoticedAt,
        progressSlaMs: SUBAGENT_PROGRESS_SLA_MS,
      },
    };
  }

  const requiresCompletion =
    entry.expectsCompletionMessage !== false && entry.delivery?.status !== "not_required";
  const terminal = typeof entry.endedAt === "number" && entry.outcome !== undefined;
  const deliveryStatus = entry.delivery?.status;
  if (!terminal || !requiresCompletion || deliveryStatus === "delivered") {
    return undefined;
  }

  return {
    ...base,
    reason: "child_terminal",
    dedupeKey: `subagent-terminal:${entry.runId}:${targetRef}`,
    ...(deliveryStatus === "suspended"
      ? { suspendedReason: entry.delivery?.suspendedReason ?? "owner_delivery_suspended" }
      : deliveryStatus === "discarded"
        ? {
            suspendedReason: `owner_delivery_discarded:${entry.delivery?.discardReason ?? "unknown"}`,
          }
        : {}),
    metadata: {
      sourceRevision: subagentRevision(entry),
      childSessionKey: entry.childSessionKey,
      endedAt: entry.endedAt,
      outcome: entry.outcome,
      deliveryStatus,
      deliveryAttemptCount: entry.delivery?.attemptCount,
      deliveryLastError: entry.delivery?.lastError,
      deliveryDiscardedAt: entry.delivery?.discardedAt,
      deliveryDiscardReason: entry.delivery?.discardReason,
      deliveryDiscardedPayloadSummary: entry.delivery?.discardedPayloadSummary,
    },
  };
}

export const subagentRunsOwnerAdapter: DurableOwnerAdapter = {
  sourceOwner: "subagent_runs",

  inspect(sourceRef): DurableOwnerAttentionFact | undefined {
    const entry = getSubagentRunFromSqlite(sourceRef);
    return entry ? subagentAttentionFact(entry) : undefined;
  },

  listAttentionFacts(options): DurableOwnerAttentionFact[] {
    const facts = listSubagentAttentionCandidatesFromSqlite().flatMap((entry) => {
      const fact = subagentAttentionFact(entry, options?.now);
      return fact ? [fact] : [];
    });
    return options?.limit === undefined ? facts : facts.slice(0, options.limit);
  },

  async dispatchAttention({ wake, claimToken }): Promise<DurableOwnerDispatchResult> {
    const entry = getSubagentRunFromSqlite(wake.sourceRef);
    if (!entry) {
      return { kind: "suspended", reason: "canonical_subagent_missing" };
    }
    const currentRevision = subagentRevision(entry);
    if (wake.reason === "child_overdue") {
      const revisionGate = gateChangedSourceRevision({
        wake,
        currentRevision,
        currentFact: subagentAttentionFact(entry, wake.createdAt),
      });
      if (revisionGate) {
        return revisionGate;
      }
      if (typeof entry.endedAt === "number") {
        return { kind: "superseded", reason: "canonical_owner_became_terminal" };
      }
      // The canonical subagent timer remains the primary progress path. This
      // source-backed fallback uses one persistent session outbox entry instead
      // of invoking that volatile path and then enqueueing a duplicate notice.
      return await dispatchDurableProgressFallback({
        wake,
        claimToken,
        canonicalOwner: "subagent_runs",
      });
    }
    if (entry.delivery?.status === "delivered") {
      return {
        kind: "acknowledged",
        evidence: {
          proofBoundary: "canonical_owner_delivery",
          deliveredAt: entry.delivery.deliveredAt ?? entry.delivery.announcedAt,
        },
      };
    }
    if (entry.delivery?.status === "suspended") {
      return {
        kind: "suspended",
        reason: entry.delivery.suspendedReason ?? "canonical_owner_delivery_suspended",
      };
    }
    if (entry.expectsCompletionMessage === false || entry.delivery?.status === "not_required") {
      return { kind: "superseded", reason: "canonical_owner_delivery_not_required" };
    }
    const revisionGate = gateChangedSourceRevision({
      wake,
      currentRevision,
      currentFact: subagentAttentionFact(entry, wake.createdAt),
    });
    if (revisionGate) {
      return revisionGate;
    }
    if (typeof entry.endedAt !== "number" || !entry.outcome) {
      return { kind: "deferred", reason: "canonical_owner_not_terminal" };
    }

    const { requestSubagentCompletionDelivery } = await import("../agents/subagent-registry.js");
    const result = requestSubagentCompletionDelivery(entry.runId);
    if (result.status === "delivered") {
      return {
        kind: "acknowledged",
        evidence: { proofBoundary: "canonical_owner_delivery", ownerResult: result.status },
      };
    }
    if (result.status === "suspended" || result.status === "missing") {
      return { kind: "suspended", reason: `canonical_owner_${result.status}` };
    }
    if (result.status === "not_required") {
      return { kind: "superseded", reason: "canonical_owner_delivery_not_required" };
    }
    return {
      kind: "deferred",
      reason: `canonical_owner_${result.status}`,
      evidence: { ownerResult: result.status },
    };
  },
};

function taskRevision(task: TaskRecord): string {
  return [
    task.status,
    task.deliveryStatus,
    task.lastEventAt ?? 0,
    task.endedAt ?? 0,
    task.terminalOutcome ?? "none",
  ].join(":");
}

function taskAttentionFact(
  task: TaskRecord,
  now = Date.now(),
): DurableOwnerAttentionFact | undefined {
  if (
    task.runtime === "subagent" ||
    task.notifyPolicy === "silent" ||
    task.deliveryStatus === "not_applicable"
  ) {
    return undefined;
  }
  const ownerRef = task.ownerKey.trim() || task.requesterSessionKey.trim();
  const targetResolved = ownerRef.length > 0;
  const targetRef = targetResolved ? ownerRef : `task_runs:${task.taskId}`;
  const base = {
    sourceOwner: "task_runs",
    sourceRef: task.taskId,
    sourceRevision: taskRevision(task),
    targetKind: targetResolved ? ("agent_session" as const) : ("inspect_only" as const),
    targetRef,
    targetResolutionStatus: targetResolved ? ("resolved" as const) : ("missing" as const),
    targetResolutionReason: targetResolved
      ? "requester session resolved from canonical task owner"
      : "canonical task owner has no requester session",
    ...(targetResolved ? { ownerRef, reportRouteRef: ownerRef } : {}),
  };
  const active = task.status === "queued" || task.status === "running";
  const progressBoundary = task.lastEventAt ?? task.startedAt ?? task.createdAt;
  if (active && now - progressBoundary >= TASK_PROGRESS_SLA_MS) {
    return {
      ...base,
      reason: "child_overdue",
      dedupeKey: `task-progress:${task.taskId}:${Math.floor(now / TASK_PROGRESS_SLA_MS)}`,
      metadata: {
        sourceRevision: taskRevision(task),
        runtime: task.runtime,
        status: task.status,
        lastEventAt: task.lastEventAt,
        progressSummary: task.progressSummary,
        progressSlaMs: TASK_PROGRESS_SLA_MS,
      },
    };
  }
  const terminal =
    task.status === "succeeded" ||
    task.status === "failed" ||
    task.status === "timed_out" ||
    task.status === "cancelled" ||
    task.status === "lost";
  const deliveryNeedsAttention =
    task.deliveryStatus === "pending" ||
    task.deliveryStatus === "session_queued" ||
    task.deliveryStatus === "failed" ||
    task.deliveryStatus === "parent_missing";
  if (!terminal || !deliveryNeedsAttention) {
    return undefined;
  }
  return {
    ...base,
    reason: task.status === "lost" ? "restart_interrupted" : "child_terminal",
    dedupeKey: `task-terminal:${task.taskId}:${task.status}:${task.endedAt ?? 0}`,
    metadata: {
      sourceRevision: taskRevision(task),
      runtime: task.runtime,
      status: task.status,
      deliveryStatus: task.deliveryStatus,
      endedAt: task.endedAt,
      terminalOutcome: task.terminalOutcome,
      terminalSummary: task.terminalSummary,
      error: task.error,
    },
  };
}

export const taskRunsOwnerAdapter: DurableOwnerAdapter = {
  sourceOwner: "task_runs",

  inspect(sourceRef): DurableOwnerAttentionFact | undefined {
    const task = getTaskById(sourceRef);
    return task ? taskAttentionFact(task) : undefined;
  },

  listAttentionFacts(options): DurableOwnerAttentionFact[] {
    const facts = listTaskRecords().flatMap((task) => {
      const fact = taskAttentionFact(task, options?.now);
      return fact ? [fact] : [];
    });
    return options?.limit === undefined ? facts : facts.slice(0, options.limit);
  },

  async dispatchAttention({ wake, claimToken }): Promise<DurableOwnerDispatchResult> {
    const task = getTaskById(wake.sourceRef);
    if (!task) {
      return { kind: "suspended", reason: "canonical_task_missing" };
    }
    const currentRevision = taskRevision(task);
    if (task.deliveryStatus === "delivered") {
      return {
        kind: "acknowledged",
        evidence: {
          proofBoundary: "canonical_task_owner_delivery",
          deliveryStatus: task.deliveryStatus,
        },
      };
    }
    const revisionGate = gateChangedSourceRevision({
      wake,
      currentRevision,
      currentFact: taskAttentionFact(task, wake.createdAt),
    });
    if (revisionGate) {
      return revisionGate;
    }
    if (wake.reason === "child_overdue") {
      // Task progress normally flows through the task owner. Once the durable
      // SLA has expired, use the persistent session outbox as the single
      // fallback handoff so the parent does not receive two progress notices.
      return await dispatchDurableProgressFallback({
        wake,
        claimToken,
        canonicalOwner: "task_runs",
      });
    }
    let sessionHandoff: SessionAttentionDeliveryResult | undefined;
    const result = await requestTaskAttentionDelivery({
      taskId: wake.sourceRef,
      sessionHandoff: async (handoff) => {
        sessionHandoff = await requestSessionAttentionDelivery({
          sessionKey: handoff.sessionKey,
          text: handoff.text,
          contextKey: handoff.contextKey,
          deliveryContext: handoff.deliveryContext,
          idempotencyKey: `durable-wake:${wake.wakeId}`,
          wakeId: wake.wakeId,
        });
        return sessionHandoff.status === "handoff_accepted";
      },
    });
    if (result.status === "missing") {
      return { kind: "suspended", reason: "canonical_task_missing" };
    }
    if (result.status === "delivered") {
      if (result.mode === "terminal" && result.deliveryStatus === "delivered") {
        return {
          kind: "acknowledged",
          evidence: {
            proofBoundary: "canonical_task_owner_delivery",
            ownerResult: result.status,
            mode: result.mode,
            deliveryStatus: result.deliveryStatus,
          },
        };
      }
      if (!sessionHandoff || sessionHandoff.status === "missing") {
        return {
          kind: "deferred",
          reason: "canonical_task_session_handoff_not_proven",
          evidence: { mode: result.mode, deliveryStatus: result.deliveryStatus },
        };
      }
      return {
        kind: "handoff_accepted",
        evidence: {
          proofBoundary: "persistent_session_queue_acceptance",
          sessionKey: sessionHandoff.sessionKey,
          sessionId: sessionHandoff.sessionId,
          deliveryQueueId: sessionHandoff.deliveryQueueId,
          duplicate: sessionHandoff.duplicate,
          immediateAdmission: sessionHandoff.immediateAdmission,
          queuedAt: sessionHandoff.queuedAt,
          generationFenced: Boolean(sessionHandoff.sessionId),
          attachedSessionConsumptionProven: false,
          userDeliveryProven: false,
          canonicalOwner: "task_runs",
          ownerResult: result.status,
          mode: result.mode,
          deliveryStatus: result.deliveryStatus,
        },
      };
    }
    if (result.status === "superseded") {
      return { kind: "superseded", reason: result.reason };
    }
    if (result.status === "suspended") {
      return {
        kind: "suspended",
        reason: result.reason,
        evidence: { deliveryStatus: result.deliveryStatus },
      };
    }
    return {
      kind: "deferred",
      reason: result.reason,
      evidence: { deliveryStatus: result.deliveryStatus },
    };
  },
};

function flowRevision(flow: TaskFlowRecord): string {
  return [flow.revision, flow.status, flow.updatedAt, flow.endedAt ?? 0].join(":");
}

function flowAttentionFact(
  flow: TaskFlowRecord,
  now = Date.now(),
): DurableOwnerAttentionFact | undefined {
  if (flow.syncMode !== "managed" || flow.notifyPolicy === "silent") {
    return undefined;
  }
  const ownerRef = flow.ownerKey.trim();
  const targetResolved = ownerRef.length > 0;
  const targetRef = targetResolved ? ownerRef : `flow_runs:${flow.flowId}`;
  const base = {
    sourceOwner: "flow_runs",
    sourceRef: flow.flowId,
    sourceRevision: flowRevision(flow),
    targetKind: targetResolved ? ("agent_session" as const) : ("inspect_only" as const),
    targetRef,
    targetResolutionStatus: targetResolved ? ("resolved" as const) : ("missing" as const),
    targetResolutionReason: targetResolved
      ? "owner session resolved from canonical managed flow"
      : "canonical managed flow has no owner session",
    ...(targetResolved ? { ownerRef, reportRouteRef: ownerRef } : {}),
  };
  const active =
    flow.status === "queued" ||
    flow.status === "running" ||
    flow.status === "waiting" ||
    flow.status === "blocked";
  if (active && now - flow.updatedAt >= FLOW_PROGRESS_SLA_MS) {
    const reason =
      flow.status === "waiting" || flow.status === "blocked"
        ? ("fan_in_incomplete" as const)
        : ("child_overdue" as const);
    return {
      ...base,
      reason,
      dedupeKey: `flow-attention:${flow.flowId}:${flow.revision}:${Math.floor(now / FLOW_PROGRESS_SLA_MS)}`,
      metadata: {
        sourceRevision: flowRevision(flow),
        status: flow.status,
        revision: flow.revision,
        currentStep: flow.currentStep,
        blockedTaskId: flow.blockedTaskId,
        blockedSummary: flow.blockedSummary?.slice(0, 500),
        updatedAt: flow.updatedAt,
        progressSlaMs: FLOW_PROGRESS_SLA_MS,
      },
    };
  }
  if (flow.status !== "failed" && flow.status !== "lost") {
    return undefined;
  }
  return {
    ...base,
    reason: flow.status === "lost" ? "restart_interrupted" : "child_terminal",
    dedupeKey: `flow-terminal:${flow.flowId}:${flow.revision}`,
    metadata: {
      sourceRevision: flowRevision(flow),
      status: flow.status,
      revision: flow.revision,
      currentStep: flow.currentStep,
      blockedTaskId: flow.blockedTaskId,
      blockedSummary: flow.blockedSummary?.slice(0, 500),
      endedAt: flow.endedAt,
    },
  };
}

export const flowRunsOwnerAdapter: DurableOwnerAdapter = {
  sourceOwner: "flow_runs",

  inspect(sourceRef): DurableOwnerAttentionFact | undefined {
    const flow = getTaskFlowById(sourceRef);
    return flow ? flowAttentionFact(flow) : undefined;
  },

  listAttentionFacts(options): DurableOwnerAttentionFact[] {
    const facts = listTaskFlowRecords().flatMap((flow) => {
      const fact = flowAttentionFact(flow, options?.now);
      return fact ? [fact] : [];
    });
    return options?.limit === undefined ? facts : facts.slice(0, options.limit);
  },

  async dispatchAttention({ wake, claimToken }): Promise<DurableOwnerDispatchResult> {
    const flow = getTaskFlowById(wake.sourceRef);
    if (!flow) {
      return { kind: "suspended", reason: "canonical_flow_missing" };
    }
    if (flow.status === "succeeded" || flow.status === "cancelled") {
      return { kind: "superseded", reason: "canonical_flow_no_longer_requires_attention" };
    }
    const currentRevision = flowRevision(flow);
    const revisionGate = gateChangedSourceRevision({
      wake,
      currentRevision,
      currentFact: flowAttentionFact(flow, wake.createdAt),
    });
    if (revisionGate) {
      return revisionGate;
    }
    return await sessionStoreOwnerAdapter.dispatchAttention({ wake, claimToken });
  },
};

const ownerAdapters = new Map<string, DurableOwnerAdapter>([
  [subagentRunsOwnerAdapter.sourceOwner, subagentRunsOwnerAdapter],
  [taskRunsOwnerAdapter.sourceOwner, taskRunsOwnerAdapter],
  [flowRunsOwnerAdapter.sourceOwner, flowRunsOwnerAdapter],
  [sessionStoreOwnerAdapter.sourceOwner, sessionStoreOwnerAdapter],
]);

export function getDurableOwnerAdapter(sourceOwner: string): DurableOwnerAdapter | undefined {
  return ownerAdapters.get(sourceOwner);
}

export function reconcileDurableOwnerAttentionFact(params: {
  store: DurableRuntimeStore;
  fact: DurableOwnerAttentionFact;
  now: number;
}): { wake: WakeObligation; created: boolean; suspended: boolean } {
  const { fact } = params;
  const parentRuntimeRun = fact.requesterRunId
    ? params.store.getRunByIdempotencyKey(DURABLE_AGENT_TURN_OPERATION_KIND, fact.requesterRunId)
    : undefined;
  const existing = params.store.getWakeObligationByDedupeKey(fact.dedupeKey);
  const sourceRevisionAdvanced =
    existing !== undefined && wakeSourceRevision(existing) !== fact.sourceRevision;
  const factsRef = `${fact.sourceOwner}:${fact.sourceRef}:${fact.sourceRevision}`;
  const projectedMetadata = {
    ...fact.metadata,
    requesterRunId: fact.requesterRunId,
    parentCorrelation: parentRuntimeRun
      ? "exact_agent_turn"
      : fact.requesterRunId
        ? "requester_run_not_found_session_fallback"
        : "session_only",
  };
  let wake = params.store.createWakeObligation({
    sourceOwner: fact.sourceOwner,
    sourceRef: fact.sourceRef,
    parentRunId: parentRuntimeRun?.runtimeRunId,
    parentSessionKey: fact.ownerRef,
    targetKind: fact.targetKind,
    targetRef: fact.targetRef,
    ownerKind: fact.targetKind === "agent_session" ? "agent_session" : undefined,
    ownerRef: fact.ownerRef,
    reportRouteRef: fact.reportRouteRef,
    targetResolutionStatus: fact.targetResolutionStatus,
    targetResolutionReason: fact.targetResolutionReason,
    reason: fact.reason,
    factsRef,
    dedupeKey: fact.dedupeKey,
    metadata: projectedMetadata,
    now: params.now,
  });
  if (existing && wake.status !== "acked" && wake.status !== "superseded") {
    wake =
      params.store.updateWakeObligationProjection({
        wakeId: wake.wakeId,
        factsRef,
        metadata: { ...wake.metadata, ...projectedMetadata },
        now: params.now,
      }) ?? wake;
  }
  if (!fact.suspendedReason && sourceRevisionAdvanced && wake.status === "suspended") {
    wake =
      params.store.resumeWakeObligation({
        wakeId: wake.wakeId,
        actorKind: "system_worker",
        actorRef: "owner_fact_reconciliation",
        reason: "canonical source revision advanced",
        decisionRef: factsRef,
        idempotencyKey: `source-revision:${fact.sourceRevision}`,
        expectedSourceRevision: fact.sourceRevision,
        evidence: {
          previousSourceRevision: existing ? wakeSourceRevision(existing) : undefined,
          sourceRevision: fact.sourceRevision,
        },
        now: params.now,
      }) ?? wake;
  }
  if (!fact.suspendedReason || wake.status === "acked" || wake.status === "superseded") {
    return { wake, created: !existing, suspended: false };
  }
  const updated = params.store.suspendWakeObligation({
    wakeId: wake.wakeId,
    failedReason: fact.suspendedReason,
    metadata: { ...wake.metadata, ...projectedMetadata },
    now: params.now,
  });
  return {
    wake: updated ?? wake,
    created: !existing,
    suspended: updated?.status === "suspended",
  };
}

export function reconcileDurableOwnerAttentionFacts(params: {
  store: DurableRuntimeStore;
  now: number;
  limit?: number;
}): { scanned: number; created: number; suspended: number } {
  let scanned = 0;
  let created = 0;
  let suspended = 0;
  for (const adapter of ownerAdapters.values()) {
    for (const fact of adapter.listAttentionFacts({ limit: params.limit, now: params.now })) {
      scanned += 1;
      const reconciled = reconcileDurableOwnerAttentionFact({
        store: params.store,
        fact,
        now: params.now,
      });
      if (reconciled.created) {
        created += 1;
      }
      if (reconciled.suspended) {
        suspended += 1;
      }
    }
  }
  return { scanned, created, suspended };
}
