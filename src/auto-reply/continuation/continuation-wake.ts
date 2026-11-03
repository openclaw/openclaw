import {
  resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore,
} from "../../config/sessions.js";
// Continuation (karmaterminal): wakes a session for its pending continuation returns through
// upstream's session-event handoff. Upstream retired heartbeat turns (#180192, #180563); this is
// the continuation wake that replaced `requestHeartbeatNow`, never a resurrected heartbeat runner.
//
// A return is a MANAGED system event: its durable session-delivery row (the event's ack id) owns
// delivery and the in-memory event is only the fast path. A wake names the rows it was raised for.
// Requests for one session and delivery class coalesce into ONE ordinary event turn that carries
// every named occurrence with its own identity (turns coalesce, payloads never merge). The rows
// are acknowledged only once that turn is adopted. A refused or never-adopted turn leaves its
// occurrences queued as passive events and their rows pending, so the next ordinary turn, the
// delivery scheduler or a restart replay still owns them.
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { withCurrentSessionRecipientAuthority } from "../../config/sessions/session-recipient-authority-current.js";
import { emitContinuationQueueDrainSpan } from "../../infra/continuation-tracer.js";
import { ackSessionDelivery } from "../../infra/session-delivery-queue-storage.js";
import {
  claimSystemEventDeliveryAdoption,
  releaseSystemEventDeliveryAdoption,
} from "../../infra/system-event-delivery-claims.js";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import {
  isSystemEventTurnOwned,
  peekDeliverableSystemEventEntries,
  type SystemEvent,
} from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isSubagentSessionKey } from "../../sessions/session-key-utils.js";
import type { ContinuationTrigger } from "../get-reply-options.types.js";
import { enqueueSessionEventForHost } from "../reply/session-event-handoff.js";
import { getSessionEventRuntimeConfig } from "../reply/session-event-target.js";
import { settleStaleSystemEventAuthority } from "../reply/session-system-event-adoption.js";
import { captureContinuationQueueContext } from "./queue-context.js";

const log = createSubsystemLogger("continuation/wake");

/** Same window the retired heartbeat wake coalesced over. */
const CONTINUATION_WAKE_COALESCE_MS = 250;

export type ContinuationWakeRequest = {
  sessionKey: string;
  /** Owning agent, when the key alone does not name it. */
  agentId?: string;
  /**
   * `delegate-return` and `silent-wake-enrichment` are mid-chain delegate returns; any other
   * reason (a durable notice) wakes an ordinary event turn without a continuation trigger.
   */
  reason: string;
  /** Run whose completion produced the return; the woken turn's lineage. */
  parentRunId?: string;
  /** Durable rows (ack ids) whose queued events this wake hands to the turn. */
  deliveryIds: readonly string[];
};

type PendingWake = {
  sessionKey: string;
  agentId: string;
  silent: boolean;
  continuationTrigger?: ContinuationTrigger;
  parentRunId?: string;
  /** Each row with its producing run; a coalesced wake's parentRunId names only the last (#1504). */
  deliveries: Map<string, string | undefined>;
  timer: ReturnType<typeof setTimeout>;
};

const pendingWakes = new Map<string, PendingWake>();
const inFlightWakes = new Set<Promise<void>>();

function resolveContinuationWakeTrigger(reason: string): ContinuationTrigger | undefined {
  return reason === "delegate-return" || reason === "silent-wake-enrichment"
    ? "delegate-return"
    : undefined;
}

/**
 * Queue a wake for the named returns. Silent-wake enrichment stays transport-silent: it never
 * shares a turn with a visible wake, and its turn records the result without channel delivery.
 */
export function requestContinuationWake(request: ContinuationWakeRequest): void {
  if (request.deliveryIds.length === 0) {
    return;
  }
  const agentId = resolveAgentIdFromSessionKey(request.sessionKey, request.agentId);
  const silent = request.reason === "silent-wake-enrichment";
  const key = `${resolveSystemEventQueueKey(request.sessionKey, agentId)}\u0000${silent}`;
  const trigger = resolveContinuationWakeTrigger(request.reason);
  const existing = pendingWakes.get(key);
  if (existing) {
    for (const id of request.deliveryIds) {
      existing.deliveries.set(id, request.parentRunId ?? existing.deliveries.get(id));
    }
    existing.continuationTrigger ??= trigger;
    existing.parentRunId = request.parentRunId ?? existing.parentRunId;
    return;
  }
  const wake: PendingWake = {
    sessionKey: request.sessionKey,
    agentId,
    silent,
    ...(trigger ? { continuationTrigger: trigger } : {}),
    ...(request.parentRunId ? { parentRunId: request.parentRunId } : {}),
    deliveries: new Map(request.deliveryIds.map((id) => [id, request.parentRunId])),
    timer: setTimeout(() => runPendingWake(key), CONTINUATION_WAKE_COALESCE_MS),
  };
  wake.timer.unref?.();
  pendingWakes.set(key, wake);
}

function runPendingWake(key: string): void {
  const wake = pendingWakes.get(key);
  if (!wake) {
    return;
  }
  pendingWakes.delete(key);
  const run = handOffContinuationWake(wake).catch((error: unknown) => {
    log.warn(
      `[continuation:wake-failed] session=${wake.sessionKey} rows=${[...wake.deliveries.keys()].join(",")} error=${error instanceof Error ? error.message : String(error)}`,
    );
  });
  inFlightWakes.add(run);
  void run.finally(() => inFlightWakes.delete(run));
}

async function handOffContinuationWake(wake: PendingWake): Promise<void> {
  const queueKey = resolveSystemEventQueueKey(wake.sessionKey, wake.agentId);
  const pending = peekDeliverableSystemEventEntries(queueKey).filter(
    (event) =>
      event.sessionDeliveryAckId !== undefined &&
      wake.deliveries.has(event.sessionDeliveryAckId) &&
      !isSystemEventTurnOwned(queueKey, event),
  );
  if (pending.length === 0) {
    // An ordinary turn already adopted them, or a replay will queue them again.
    return;
  }
  const storePath = resolveSessionStorePathCore(getSessionEventRuntimeConfig().session?.store, {
    agentId: wake.agentId,
  });
  const authorityScope = { agentId: wake.agentId, sessionKey: wake.sessionKey, storePath };
  const entry = await readSessionEntryReadOnlyInWorker({
    ...authorityScope,
    projection: "list",
  });
  const bound = pending.filter((event) => event.recipientAuthority);
  const stale: SystemEvent[] = [];
  const occurrences: SystemEvent[] = [];
  let adopted = false;
  const releaseUnadopted = () => {
    if (!adopted) {
      for (const event of occurrences) {
        releaseSystemEventDeliveryAdoption(event, { settled: false });
      }
    }
  };
  let receipt: ReturnType<typeof enqueueSessionEventForHost> | undefined;
  let settlementFailure: { error: unknown } | undefined;
  try {
    // The handoff is the delivery boundary: it runs inside the authority decision, under the
    // writer admission that read the epoch, so no revocation lands between check and handoff.
    await withCurrentSessionRecipientAuthority(
      bound.map((event) => ({ scope: authorityScope, authority: event.recipientAuthority! })),
      (current) => {
        const currentByEvent = new Map(bound.map((event, index) => [event, current[index]]));
        for (const event of pending) {
          if (event.recipientAuthority && !currentByEvent.get(event)) {
            stale.push(event);
            continue;
          }
          if (event.expectedSessionId && event.expectedSessionId !== entry?.sessionId) {
            // Produced for a head a reset replaced; the passive prompt owner settles it.
            continue;
          }
          occurrences.push(event);
        }
        if (occurrences.length === 0) {
          return;
        }
        // While the handed-off turn owns these rows, a scheduler retry or replay must not queue
        // them again; an adopted row keeps a lease-long tombstone, a refused one becomes free.
        for (const event of occurrences) {
          claimSystemEventDeliveryAdoption(event);
        }
        try {
          receipt = enqueueSessionEventForHost(occurrences.map((event) => event.text).join("\n"), {
            agentId: wake.agentId,
            sessionKey: wake.sessionKey,
            source: "continuation",
            occurrences,
            preserveOccurrenceOnRejection: true,
            ...(wake.parentRunId ? { sourceRunId: wake.parentRunId } : {}),
            ...(wake.silent ? { deliver: false } : {}),
            ...(wake.silent && !isSubagentSessionKey(wake.sessionKey)
              ? { replyExpectation: "optional" as const }
              : {}),
            continuation: {
              ...(wake.continuationTrigger
                ? { continuationTrigger: wake.continuationTrigger }
                : {}),
              ...(wake.parentRunId ? { parentRunId: wake.parentRunId } : {}),
              // The turn's input row names every row it consumes and the run that produced it.
              continuationInputDeliveries: occurrences.flatMap(({ sessionDeliveryAckId: id }) => {
                const sourceRunId = id ? wake.deliveries.get(id) : undefined;
                return id ? [{ deliveryId: id, ...(sourceRunId ? { sourceRunId } : {}) }] : [];
              }),
            },
            onAdopted: async () => {
              adopted = true;
              // Handed-off occurrences skip the passive queue drain; their adoption is the drain.
              emitContinuationQueueDrainSpan({
                drainedCount: occurrences.length,
                drainedContinuationCount: occurrences.filter((event) =>
                  event.text.startsWith("[continuation:"),
                ).length,
                // Refused in this same authority decision; their rows retire after the handoff.
                ...(stale.length > 0
                  ? { refusedCount: stale.length, refusalReason: "recipient-authority-changed" }
                  : {}),
                traceparent: occurrences.find((event) => event.traceparent)?.traceparent,
                log: (message) => log.warn(message),
              });
              await acknowledgeAdoptedReturns(occurrences);
            },
          });
        } catch (error) {
          releaseUnadopted();
          throw error;
        }
      },
    );
  } finally {
    for (const event of stale) {
      try {
        // The recipient no longer owns the session: retire the row, never deliver it.
        await settleStaleSystemEventAuthority({ event, sessionKey: queueKey, stage: "wake" });
      } catch (error) {
        // An unsettled stale row replays later; the current claims below must settle now.
        settlementFailure ??= { error };
      }
    }
  }
  if (receipt) {
    const outcome = await receipt.settled;
    releaseUnadopted();
    if (!adopted) {
      log.info(
        `[continuation:wake-not-adopted] session=${wake.sessionKey} status=${outcome.status} rows=${occurrences.map((event) => event.sessionDeliveryAckId).join(",")}${outcome.error ? ` error=${outcome.error}` : ""}`,
      );
    }
  }
  if (settlementFailure) {
    throw settlementFailure.error;
  }
}

/** The adopted turn owns the returns now; a failed ack leaves its row to replay after the lease. */
async function acknowledgeAdoptedReturns(occurrences: readonly SystemEvent[]): Promise<void> {
  for (const event of occurrences) {
    const ackId = event.sessionDeliveryAckId;
    if (!ackId) {
      continue;
    }
    try {
      await ackSessionDelivery(
        ackId,
        captureContinuationQueueContext(event.sessionDeliveryAckStateDir),
      );
      releaseSystemEventDeliveryAdoption(event, { settled: true });
    } catch (error) {
      log.warn(
        `[continuation:wake-ack-failed] row=${ackId} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** Runs every coalesced wake now and waits for their handoffs to settle. Test-only. */
export async function settleContinuationWakesForTest(): Promise<void> {
  for (const [key, wake] of pendingWakes) {
    clearTimeout(wake.timer);
    runPendingWake(key);
  }
  await Promise.allSettled(inFlightWakes);
}

/** Drops queued wakes without running them. Test-only. */
export function resetContinuationWakesForTest(): void {
  for (const wake of pendingWakes.values()) {
    clearTimeout(wake.timer);
  }
  pendingWakes.clear();
}
