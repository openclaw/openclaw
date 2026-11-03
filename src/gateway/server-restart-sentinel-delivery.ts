import {
  CONTINUATION_RESET_HOLD_MAX_MS,
  findContinuationResetHold,
} from "../agents/subagents/registry/subagent-continuation-reset-retention.js";
import { requestContinuationWake } from "../auto-reply/continuation/continuation-wake.js";
import { reportRefusedContinuationReturn } from "../auto-reply/continuation/return-refusal.js";
import { deliverQueuedPostCompactionDelegate } from "../auto-reply/reply/post-compaction-delegate-delivery.js";
import type { CliDeps } from "../cli/deps.types.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  isSessionRecipientAuthorityCurrentInWorker,
  withCurrentSessionRecipientAuthority,
} from "../config/sessions/session-recipient-authority-current.js";
import type { SessionRecipientAuthority } from "../config/sessions/session-recipient-authority-types.js";
import {
  type ContinuationReturnWake,
  SessionDeliveryDeadLetteredError,
  SessionDeliveryDeferredError,
  type QueuedSessionDelivery,
} from "../infra/session-delivery-queue-storage.js";
import { hasQueuedSystemEventDelivery } from "../infra/system-event-managed-delivery-queue.js";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { isSubagentSessionKey } from "../sessions/session-key-utils.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { findCanonicalStoreMatch } from "./session-utils-store-selection.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";

const log = createSubsystemLogger("gateway/restart-sentinel");

/**
 * - `queued`: the event is in the queue (newly admitted, or its durable row
 *   already rides a queued copy).
 * - `refused`: the queue is full and nothing was queued. The caller must keep
 *   the durable row pending for a retry and must not report success.
 * - `stale-authority`: recipient authority changed; nothing was queued.
 */
type RestartSentinelWakeOutcome = "queued" | "refused" | "stale-authority";

/**
 * A replayed return whose recipient authority advanced is refused: never queued or woken, and its
 * row settles as failed rather than as recovered, so replay never reports it delivered. A row with
 * a copy in memory, or a turn adopting one, belongs to that copy's owner: the turn adopts it (its
 * decision ran while authority was current) or gives it back, and a copy is refused where it is
 * next seen. Replay refuses only a row it alone holds.
 */
function refuseStaleAuthorityReplay(params: {
  sessionKey: string;
  agentId: string;
  queueId: string;
  stateDir: string | undefined;
}): never {
  const identity = {
    sessionKey: params.sessionKey,
    sessionDeliveryAckId: params.queueId,
    ...(params.stateDir ? { sessionDeliveryAckStateDir: params.stateDir } : {}),
  };
  if (hasQueuedSystemEventDelivery(withSystemEventOwner(identity, params.agentId))) {
    throw new SessionDeliveryDeferredError("system event is awaiting durable prompt adoption", {
      awaitingAdoptionInMemory: true,
    });
  }
  reportRefusedContinuationReturn({
    stage: "replay",
    reason: "recipient-authority-changed",
    sessionKey: params.sessionKey,
    deliveryId: params.queueId,
  });
  throw new SessionDeliveryDeadLetteredError(
    "continuation return refused: recipient-authority-changed",
  );
}

/**
 * The row stays pending and the delivery scheduler retries it without charging
 * its retry budget. The scheduler backs off and reports sustained saturation
 * (rate-limited), so each attempt here logs only at debug.
 */
function deferRefusedRestartSentinelWake(params: {
  sessionKey: string;
  queueId: string;
  continuationReturn?: boolean;
}): never {
  log.debug("session event delivery deferred: system event queue is full", params);
  throw new SessionDeliveryDeferredError("system event queue is full; retrying the durable row", {
    capacity: {
      sessionKey: params.sessionKey,
      continuationReturn: params.continuationReturn === true,
    },
  });
}

function enqueueRestartSentinelWake(params: {
  /** Durable queue row id; keys the wake so recovered work keeps its turn budget. */
  entryId: string;
  message: string;
  sessionKey: string;
  agentId: string;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  traceparent?: string;
  sessionDeliveryAckId?: string;
  sessionDeliveryAckStateDir?: string;
  recipientAuthority?: SessionRecipientAuthority;
  awaitsTurnAdoption?: boolean;
  /** A continuation return's own wake; absent keeps the generic restart-sentinel wake. */
  returnWake?: ContinuationReturnWake;
}): RestartSentinelWakeOutcome {
  const eventOptions = {
    sessionKey: params.sessionKey,
    // Recovered work keeps its ordinary turn budget when its wake runs the turn.
    contextKey: `task:restart-sentinel:${params.entryId}`,
    trusted: true,
    // The durable row owns this contract; a replayed event must carry it too, or
    // the re-created in-memory copy would be acked at prompt preparation.
    ...(params.awaitsTurnAdoption ? { sessionDeliveryAwaitsTurnAdoption: true } : {}),
    ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
    ...(params.traceparent ? { traceparent: params.traceparent } : {}),
    ...(params.sessionDeliveryAckId ? { sessionDeliveryAckId: params.sessionDeliveryAckId } : {}),
    ...(params.sessionDeliveryAckStateDir
      ? { sessionDeliveryAckStateDir: params.sessionDeliveryAckStateDir }
      : {}),
    ...(params.recipientAuthority ? { recipientAuthority: params.recipientAuthority } : {}),
  };
  const ownedOptions = withSystemEventOwner(eventOptions, params.agentId);
  // A row whose event is already queued, or that a prepared turn is adopting,
  // is delivered: replaying it (a retry, or the periodic pending sweep) must
  // neither replace the queued occurrence nor wake the session again.
  const admitted =
    !hasQueuedSystemEventDelivery(ownedOptions) && enqueueSystemEvent(params.message, ownedOptions);
  if (!admitted) {
    // `false` is either a capacity refusal or a de-duplicated re-enqueue of a
    // row that already rides a queued event (whose producer already woke the
    // session). Only the latter is delivered; neither needs another wake.
    return hasQueuedSystemEventDelivery(ownedOptions) ? "queued" : "refused";
  }
  const deliveryIds = params.sessionDeliveryAckId ? [params.sessionDeliveryAckId] : [];
  if (params.returnWake !== undefined) {
    // Replay wakes exactly as the producer's fast-path admission would have:
    // a continuation wake with the producer's reason, or none at all.
    if (params.returnWake) {
      requestContinuationWake({
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        reason: params.returnWake.reason,
        ...(params.returnWake.parentRunId ? { parentRunId: params.returnWake.parentRunId } : {}),
        deliveryIds,
      });
    }
    return "queued";
  }
  // A continuation-owned row without its own wake (a durable notice, or a row written before
  // return wakes were recorded) wakes one ordinary event turn for the session.
  requestContinuationWake({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    reason: "restart-sentinel",
    deliveryIds,
  });
  return "queued";
}

/**
 * Delivers continuation-owned rows (isContinuationSessionDelivery). Upstream's queue delivers
 * only produced media; any other legacy row is inert here too.
 */
export async function deliverQueuedSessionDeliveryCore(params: {
  deps: CliDeps;
  entry: QueuedSessionDelivery;
  queueContext: OpenClawStateWorkerContext;
  resolveGatewayContext?: import("./server-methods/types.js").GatewayContextResolver;
}) {
  params.queueContext.admission.assertCurrent();
  const stateDir = params.queueContext.environment.OPENCLAW_STATE_DIR;
  if (params.entry.kind === "postCompactionDelegate") {
    await deliverQueuedPostCompactionDelegate({
      entry: params.entry,
      queueContext: params.queueContext,
    });
    return;
  }
  if (params.entry.kind !== "systemEvent") {
    return;
  }
  const isContinuationReturn = params.entry.idempotencyKey?.startsWith("continuation-return:");
  // A continuation return settles only on prompt adoption, whether or not it
  // carries recipient authority; rows written before that rule replay the same way.
  const awaitsTurnAdoption = params.entry.awaitPromptAdoption === true || isContinuationReturn;
  if (!awaitsTurnAdoption) {
    // A plain legacy restart notice carries no continuation custody (#185730: inert).
    return;
  }
  const recipientAgentId = params.entry.agentId?.trim();
  if (isContinuationReturn && !recipientAgentId) {
    throw new SessionDeliveryDeadLetteredError(
      "continuation return recipient owner is unavailable",
    );
  }
  const explicitTargetAgentId = parseAgentSessionKey(params.entry.sessionKey)?.agentId;
  if (
    recipientAgentId &&
    explicitTargetAgentId &&
    normalizeAgentId(explicitTargetAgentId) !== normalizeAgentId(recipientAgentId)
  ) {
    throw new SessionDeliveryDeadLetteredError(
      "continuation return recipient owner mismatches its target",
    );
  }
  // Session reads stay in the worker; queue admission is re-proven after the read (#167113).
  const cfg = getRuntimeConfig();
  const { agentId, store, storeKeys, storePath, canonicalKey } =
    await resolveGatewaySessionStoreTargetInWorker({
      cfg,
      key: params.entry.sessionKey,
      env: params.queueContext.environment,
      assertActive: () => params.queueContext.admission.assertCurrent(),
      ...(recipientAgentId ? { agentId: recipientAgentId } : {}),
    });
  params.queueContext.admission.assertCurrent();
  const entry = findCanonicalStoreMatch(store, storeKeys)?.entry;
  if (
    isContinuationReturn &&
    (normalizeAgentId(agentId) !== normalizeAgentId(recipientAgentId) ||
      (!explicitTargetAgentId && !entry))
  ) {
    throw new SessionDeliveryDeadLetteredError(
      "continuation return recipient owner is no longer authoritative",
    );
  }
  // Continuation: a reset replacing this head retained the source run. A pending mark holds the
  // row until resolution releases (schedules) it or, for an orphaned run, moves it to failed
  // before the mark leaves pending. An orphaned mark still fences any row written after that, so
  // none reaches a later head. Checked before recipient authority, which is vacuous for a row
  // that captured none. Both terminal outcomes move the row to failed with
  // the drain's dead-letter warning; neither acks it as delivered.
  const resetHold = findContinuationResetHold(params.entry.continuationSourceRunId, canonicalKey);
  if (resetHold?.state === "orphaned") {
    throw new SessionDeliveryDeadLetteredError(
      `continuation return discarded: session reset ${resetHold.resetId} orphaned its source run`,
    );
  }
  if (resetHold) {
    // The 60 s pending sweep re-checks held rows, so expiry needs no reset or boot to fire. The
    // mark and its run are left alone: an old handover is not a reason to stop a valid child.
    const heldMs = Date.now() - Math.max(resetHold.markedAt, params.entry.enqueuedAt);
    if (heldMs >= CONTINUATION_RESET_HOLD_MAX_MS) {
      throw new SessionDeliveryDeadLetteredError(
        `continuation return expired after ${Math.floor(heldMs / 86_400_000)} days held by unresolved session reset ${resetHold.resetId}`,
      );
    }
    throw new SessionDeliveryDeferredError("continuation return is held by a pending reset", {
      heldByOwner: true,
    });
  }
  const recipientAuthority = params.entry.recipientAuthority;
  // The row's owning state dir, as the session read above; recovery may run under another env.
  const authorityScope = {
    agentId,
    sessionKey: canonicalKey,
    storePath,
    env: params.queueContext.environment,
  };
  if (
    recipientAuthority &&
    !(await isSessionRecipientAuthorityCurrentInWorker(authorityScope, recipientAuthority))
  ) {
    refuseStaleAuthorityReplay({
      sessionKey: canonicalKey,
      agentId: params.entry.agentId ?? agentId,
      queueId: params.entry.id,
      stateDir,
    });
  }
  if (!entry && isSubagentSessionKey(canonicalKey)) {
    // A missing subagent session cannot adopt the row: the wake's handoff refuses an absent
    // origin, so the row would replay on every restart without ever settling.
    throw new SessionDeliveryDeadLetteredError(
      "adoption-scoped delivery targets a subagent session that no longer exists",
    );
  }
  // Continuation-owned rows keep adoption-scoped custody: the queued event
  // carries the row's ack id, recipient authority and return wake, and the
  // row settles only when a prompt adopts it.
  const wake = {
    entryId: params.entry.id,
    message: params.entry.text,
    sessionKey: canonicalKey,
    agentId: params.entry.agentId ?? agentId,
    deliveryContext: params.entry.deliveryContext,
    traceparent: params.entry.traceparent,
    sessionDeliveryAckId: params.entry.id,
    sessionDeliveryAckStateDir: stateDir,
    recipientAuthority,
    awaitsTurnAdoption,
    ...(isContinuationReturn && params.entry.returnWake !== undefined
      ? { returnWake: params.entry.returnWake }
      : {}),
  };
  // The replay enqueues inside the authority decision, under the writer admission that read
  // the epoch; prompt adoption fences the queued event again.
  const replayed: RestartSentinelWakeOutcome = recipientAuthority
    ? await withCurrentSessionRecipientAuthority(
        [{ scope: authorityScope, authority: recipientAuthority }],
        ([current]) => (current ? enqueueRestartSentinelWake(wake) : "stale-authority"),
      )
    : enqueueRestartSentinelWake(wake);
  if (replayed === "refused") {
    deferRefusedRestartSentinelWake({
      sessionKey: canonicalKey,
      queueId: params.entry.id,
      continuationReturn: isContinuationReturn,
    });
  }
  if (replayed === "stale-authority") {
    refuseStaleAuthorityReplay({
      sessionKey: canonicalKey,
      agentId: wake.agentId,
      queueId: params.entry.id,
      stateDir,
    });
  }
  // The in-memory queue is not durable, so completing the row here would
  // drop the notice if the process
  // died before the prompt consumed it. The prompt-drain path acks the row
  // via the event's sessionDeliveryAckId once it is actually adopted.
  throw new SessionDeliveryDeferredError("system event is awaiting durable prompt adoption", {
    awaitingAdoptionInMemory: true,
  });
}
