import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import {
  drainPendingSessionDeliveries,
  type QueuedSessionDelivery,
  type SessionDeliveryRecoveryLogger,
} from "../infra/session-delivery-queue.js";
import {
  enqueueSystemEventEntry,
  peekConsumedSystemEventDeliveryQueueIds,
  peekSystemEventEntries,
} from "../infra/system-events.js";
import { requestSessionAttentionDelivery } from "../sessions/session-attention.js";
import { isDurableRuntimeEnabled } from "./config.js";
import type {
  DurableOwnerAdapter,
  DurableOwnerAttentionFact,
  DurableOwnerDispatchResult,
} from "./owner-adapter-contract.js";
import { openDurableRuntimeStore } from "./store-factory.js";
import type { WakeObligation } from "./types.js";

export function supersedeDurableSessionWakeForGenerationChange(params: {
  wakeId: string;
  deliveryQueueId: string;
  expectedSessionId?: string;
  actualSessionId?: string;
}): void {
  if (!isDurableRuntimeEnabled()) {
    throw new Error("durable runtime is disabled while a durable session wake is pending");
  }
  const store = openDurableRuntimeStore();
  try {
    const wake = store.supersedeWakeObligation({
      wakeId: params.wakeId,
      actorKind: "system_worker",
      actorRef: "session_delivery_recovery",
      reason: "target session generation changed before attached-session consumption",
      decisionRef: `session-delivery:${params.deliveryQueueId}`,
      idempotencyKey: `session-delivery-generation:${params.deliveryQueueId}`,
      evidence: {
        expectedSessionId: params.expectedSessionId,
        actualSessionId: params.actualSessionId,
        deliveryQueueId: params.deliveryQueueId,
      },
      supersededByRef: params.actualSessionId,
    });
    if (!wake) {
      const current = store.getWakeObligation(params.wakeId);
      if (current?.status !== "acked" && current?.status !== "superseded") {
        throw new Error(`durable wake could not be superseded: ${params.wakeId}`);
      }
    }
  } finally {
    store.close();
  }
}

export function acknowledgeDurableSessionWakeConsumption(params: {
  wakeId: string;
  deliveryQueueId: string;
  sessionKey: string;
  expectedSessionId?: string;
}): void {
  if (!isDurableRuntimeEnabled()) {
    throw new Error("durable runtime is disabled while a durable session wake is pending");
  }
  const store = openDurableRuntimeStore();
  try {
    const wake = store.acknowledgeWakeObligation({
      wakeId: params.wakeId,
      actorKind: "system_worker",
      actorRef: "session_attention_consumer",
      reason: "target session completed an agent run containing the durable attention event",
      decisionRef: `session-delivery:${params.deliveryQueueId}`,
      idempotencyKey: `session-delivery-consumed:${params.deliveryQueueId}`,
      evidence: {
        sessionKey: params.sessionKey,
        expectedSessionId: params.expectedSessionId,
        deliveryQueueId: params.deliveryQueueId,
        attachedSessionConsumptionProven: true,
      },
    });
    if (!wake) {
      const current = store.getWakeObligation(params.wakeId);
      if (current?.status !== "acked" && current?.status !== "superseded") {
        throw new Error(`durable wake could not be acknowledged: ${params.wakeId}`);
      }
    }
  } finally {
    store.close();
  }
}

type QueuedDurableSessionAttention = Extract<QueuedSessionDelivery, { kind: "systemEvent" }> & {
  source: { owner: "durable_wake"; ref: string };
};

function isQueuedDurableSessionAttention(
  entry: QueuedSessionDelivery,
): entry is QueuedDurableSessionAttention {
  return entry.kind === "systemEvent" && entry.source?.owner === "durable_wake";
}

/** Replay only durable session attention entries during the existing recovery tick. */
export async function recoverDurableSessionAttentionDeliveries(params: {
  log: SessionDeliveryRecoveryLogger;
}): Promise<void> {
  await drainPendingSessionDeliveries({
    drainKey: "durable-session-attention",
    logLabel: "durable session attention",
    log: params.log,
    selectEntry: (entry) => ({ match: isQueuedDurableSessionAttention(entry) }),
    deliver: async (entry) => {
      if (!isQueuedDurableSessionAttention(entry)) {
        return undefined;
      }
      if (!isDurableRuntimeEnabled()) {
        throw new Error("durable runtime is disabled while a durable session wake is pending");
      }
      const store = openDurableRuntimeStore();
      try {
        const wake = store.getWakeObligation(entry.source.ref);
        if (wake?.status === "acked" || wake?.status === "superseded") {
          return undefined;
        }
      } finally {
        store.close();
      }
      const session = loadSessionEntry({ sessionKey: entry.sessionKey, readConsistency: "latest" });
      if (
        !session ||
        (entry.expectedSessionId !== undefined && session.sessionId !== entry.expectedSessionId)
      ) {
        supersedeDurableSessionWakeForGenerationChange({
          wakeId: entry.source.ref,
          deliveryQueueId: entry.id,
          expectedSessionId: entry.expectedSessionId,
          actualSessionId: session?.sessionId,
        });
        return undefined;
      }
      if (peekConsumedSystemEventDeliveryQueueIds(entry.sessionKey).includes(entry.id)) {
        return { acknowledgement: "deferred" as const };
      }
      const alreadyAdmitted = peekSystemEventEntries(entry.sessionKey).some((event) =>
        event.deliveryQueueIds?.includes(entry.id),
      );
      if (!alreadyAdmitted) {
        enqueueSystemEventEntry(entry.text, {
          sessionKey: entry.sessionKey,
          contextKey: entry.idempotencyKey,
          deliveryContext: entry.deliveryContext,
          deliveryQueueId: entry.id,
          disableTools: entry.disableTools,
        });
        requestHeartbeat({
          source: "other",
          intent: "immediate",
          reason: "durable-attention-recovery",
          sessionKey: entry.sessionKey,
        });
      }
      return { acknowledgement: "deferred" as const };
    },
  });
}

function formatInterruptedSessionAttention(wake: WakeObligation): string {
  const sourceRun = wake.sourceRunId?.trim();
  if (
    wake.reason === "child_terminal" ||
    wake.reason === "child_overdue" ||
    wake.reason === "fan_in_incomplete"
  ) {
    return [
      `Durable owner attention is required for ${wake.sourceOwner}:${wake.sourceRef}.`,
      `Reason: ${wake.reason}.`,
      `Inspect durable wake ${wake.wakeId}${sourceRun ? ` and execution ${sourceRun}` : ""} before choosing the next step.`,
      "Send a concise progress or terminal update; do not repeat an uncertain external side effect without reconciliation.",
    ].join(" ");
  }
  return [
    "A previously accepted agent operation was interrupted by a runtime restart and did not reach a proven terminal result.",
    "Its outcome is uncertain. Do not repeat tools or external side effects automatically.",
    `Inspect durable wake ${wake.wakeId}${sourceRun ? ` and execution ${sourceRun}` : ""} before deciding whether to retry.`,
    "Send a concise status update, or request explicit retry approval when the prior side effect cannot be reconciled.",
  ].join(" ");
}

export const sessionStoreOwnerAdapter: DurableOwnerAdapter = {
  sourceOwner: "session_store",

  inspect(): DurableOwnerAttentionFact | undefined {
    return undefined;
  },

  listAttentionFacts(): DurableOwnerAttentionFact[] {
    return [];
  },

  async dispatchAttention({ wake }): Promise<DurableOwnerDispatchResult> {
    const sessionKey = wake.targetRef?.trim() || wake.ownerRef?.trim() || wake.sourceRef.trim();
    const result = await requestSessionAttentionDelivery({
      sessionKey,
      text: formatInterruptedSessionAttention(wake),
      idempotencyKey: `durable-wake:${wake.wakeId}`,
      wakeId: wake.wakeId,
      disableTools: wake.reason === "restart_interrupted",
    });
    if (result.status === "missing") {
      return {
        kind: "suspended",
        reason: result.reason === "session_not_found" ? "canonical_session_missing" : result.reason,
      };
    }
    return {
      kind: "handoff_accepted",
      evidence: {
        proofBoundary: "persistent_session_queue_acceptance",
        ownerResult: "session_delivery_enqueued",
        sessionKey: result.sessionKey,
        sessionId: result.sessionId,
        deliveryQueueId: result.deliveryQueueId,
        duplicate: result.duplicate,
        immediateAdmission: result.immediateAdmission,
        queuedAt: result.queuedAt,
        generationFenced: Boolean(result.sessionId),
        attachedSessionConsumptionProven: false,
        userDeliveryProven: false,
      },
    };
  },
};
