import { withCurrentSessionRecipientAuthority } from "../../config/sessions/session-recipient-authority-current.js";
import type { SessionRecipientAuthority } from "../../config/sessions/session-recipient-authority-types.js";
import {
  type ContinuationFanoutRecipientOutcome,
  emitContinuationFanoutSpan,
} from "../../infra/continuation-tracer.js";
import type { scheduleSessionDelivery } from "../../infra/session-delivery-queue-runtime.js";
import { enqueueSessionDelivery } from "../../infra/session-delivery-queue-storage.js";
import type {
  ContinuationReturnWake,
  QueuedSessionDeliveryPayload,
  SessionDeliveryContext,
} from "../../infra/session-delivery-queue-storage.js";
import {
  hasQueuedSystemEventDelivery,
  removeSystemEvents,
} from "../../infra/system-event-managed-delivery-queue.js";
import { resolveSessionDeliveryAckStateDir } from "../../infra/system-event-managed-delivery.js";
import { enqueueSystemEventRaw as enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { requestContinuationWake } from "./continuation-wake.js";
import { captureContinuationQueueContext } from "./queue-context.js";
import {
  refuseContinuationReturnDelivery,
  reportRefusedContinuationReturn,
} from "./return-refusal.js";
import { withContinuationOwner } from "./system-event-ownership.js";
import {
  CONTINUATION_DELEGATE_FANOUT_MODES,
  hasCrossSessionDelegateTargeting,
  normalizeContinuationTargetKey,
  normalizeContinuationTargetKeys,
} from "./targeting-pure.js";
import type {
  ContinuationDelegateFanoutMode,
  ContinuationDelegateTargeting,
} from "./targeting-pure.js";

export {
  CONTINUATION_DELEGATE_FANOUT_MODES,
  hasCrossSessionDelegateTargeting,
  normalizeContinuationTargetKey,
  normalizeContinuationTargetKeys,
};
export function resolveContinuationReturnTargetSessionKeys(
  params: ContinuationDelegateTargeting & {
    defaultSessionKey: string;
    treeSessionKeys?: readonly string[];
    allSessionKeys?: readonly string[];
    childSessionKey?: string;
  },
): string[] {
  const defaultSessionKey = normalizeContinuationTargetKey(params.defaultSessionKey);
  const fallback = defaultSessionKey ? [defaultSessionKey] : [];

  if (params.fanoutMode === "tree") {
    const treeKeys = normalizeContinuationTargetKeys(params.treeSessionKeys);
    return treeKeys.length > 0 ? treeKeys : fallback;
  }

  if (params.fanoutMode === "all") {
    const childSessionKey = normalizeContinuationTargetKey(params.childSessionKey);
    const allKeys = normalizeContinuationTargetKeys(params.allSessionKeys).filter(
      (sessionKey) => sessionKey !== childSessionKey,
    );
    return allKeys.length > 0 ? allKeys : fallback;
  }

  const explicitKeys = normalizeContinuationTargetKeys([
    ...(params.targetSessionKey ? [params.targetSessionKey] : []),
    ...(params.targetSessionKeys ?? []),
  ]);
  return explicitKeys.length > 0 ? explicitKeys : fallback;
}

type ContinuationReturnDeliveryDeps = {
  enqueueSessionDelivery: typeof enqueueSessionDelivery;
  /** Retires a written row whose recipient authority advanced; enqueue never acks a row. */
  refuseDelivery?: typeof refuseContinuationReturnDelivery;
  enqueueSystemEvent: typeof enqueueSystemEvent;
  requestContinuationWake: typeof requestContinuationWake;
  /** Decides synchronously under the recipient's authority read (writer admission). */
  withRecipientAuthority?: <T>(
    target: { sessionKey: string; agentId: string },
    authority: SessionRecipientAuthority,
    decide: (current: boolean) => T,
  ) => Promise<T>;
  removeSystemEvents?: typeof removeSystemEvents;
  /** Arms the delivery scheduler's retry for a row the full queue refused. */
  scheduleSessionDelivery?: typeof scheduleSessionDelivery;
};

const log = createSubsystemLogger("continuation/targeting");

function withRecipientAuthorityInWorker<T>(
  target: { sessionKey: string; agentId: string },
  authority: SessionRecipientAuthority,
  decide: (current: boolean) => T,
): Promise<T> {
  return withCurrentSessionRecipientAuthority([{ scope: target, authority }], ([current]) =>
    decide(Boolean(current)),
  );
}

const defaultContinuationReturnDeliveryDeps: ContinuationReturnDeliveryDeps = {
  enqueueSessionDelivery,
  enqueueSystemEvent,
  requestContinuationWake,
};

// A held return whose retry could not be armed (no delivery runtime owns this
// state database in this process) is recovered by the next runtime's startup
// scan, or by the periodic sweep of a runtime already running on the database.
// Warn once per state database and session per window; the rest go to debug.
const UNARMED_HELD_RETURN_WARN_EVERY_MS = 60_000;
const unarmedHeldReturnWarnedAt = new Map<string, number>();

function reportUnarmedHeldReturn(params: {
  deliveryId: string;
  sessionKey: string;
  stateDir?: string;
}): void {
  const now = Date.now();
  const key = `${params.stateDir ?? ""}\u0000${params.sessionKey}`;
  const message = `[continuation:return-held] system event queue full and no delivery runtime is active for this state database; deliveryId=${params.deliveryId} session=${params.sessionKey} stays pending: it is recovered when a gateway delivery runtime starts on this state database (its startup scan arms every pending row), or by the periodic sweep (every 45-75s) of a gateway delivery runtime already running on it`;
  const last = unarmedHeldReturnWarnedAt.get(key);
  if (last !== undefined && now - last < UNARMED_HELD_RETURN_WARN_EVERY_MS) {
    log.debug(message);
    return;
  }
  if (unarmedHeldReturnWarnedAt.size >= 256) {
    for (const [staleKey, at] of unarmedHeldReturnWarnedAt) {
      if (now - at >= UNARMED_HELD_RETURN_WARN_EVERY_MS) {
        unarmedHeldReturnWarnedAt.delete(staleKey);
      }
    }
  }
  unarmedHeldReturnWarnedAt.set(key, now);
  log.warn(message);
}

// Resolved on first use, like continuation-notice-surface: an eager binding
// would force every test that mocks the runtime module to declare it.
const scheduleRefusedReturnDelivery: typeof scheduleSessionDelivery = async (...args) =>
  await (
    await import("../../infra/session-delivery-queue-runtime.js")
  ).scheduleSessionDelivery(...args);

function resolveContinuationReturnDeliveryTarget(params: {
  sessionKey: string;
  recipientAgentIds?: ReadonlyMap<string, string>;
}): { sessionKey: string; recipientAgentId: string } {
  const explicitRecipientAgentId = params.sessionKey.startsWith("agent:")
    ? resolveAgentIdFromSessionKey(params.sessionKey)
    : undefined;
  const boundRecipientAgentId = params.recipientAgentIds?.get(params.sessionKey)?.trim();
  const normalizedBoundRecipientAgentId = boundRecipientAgentId
    ? normalizeAgentId(boundRecipientAgentId)
    : undefined;

  if (
    explicitRecipientAgentId &&
    normalizedBoundRecipientAgentId &&
    explicitRecipientAgentId !== normalizedBoundRecipientAgentId
  ) {
    throw new Error(`Continuation recipient owner mismatches target ${params.sessionKey}`);
  }

  const recipientAgentId = normalizedBoundRecipientAgentId ?? explicitRecipientAgentId;
  if (!recipientAgentId) {
    throw new Error(`Continuation recipient owner is unavailable for target ${params.sessionKey}`);
  }
  return {
    sessionKey: params.sessionKey,
    recipientAgentId,
  };
}

export async function enqueueContinuationReturnDeliveries(
  params: {
    targetSessionKeys: readonly string[];
    text: string;
    idempotencyKeyBase: string;
    recipientAuthorities?: ReadonlyMap<string, SessionRecipientAuthority>;
    deliveryContext?: SessionDeliveryContext;
    wakeRecipients?: boolean;
    /**
     * The wake a retry replays when it admits a held return. Defaults to this
     * call's own wake (`delegate-return` when `wakeRecipients`, else none); a
     * caller that wakes by itself names its own.
     */
    returnWake?: ContinuationReturnWake;
    childRunId?: string;
    /**
     * True while a reset is replacing this recipient's head and has retained the child: the row
     * is written but not queued, and the reset's resolution releases or terminalizes it.
     */
    holdForReset?: (sessionKey: string) => boolean;
    stateDir?: string;
    traceparent?: string;
    fanoutMode?: ContinuationDelegateFanoutMode;
    chainStepRemaining?: number;
    recipientAgentIds?: ReadonlyMap<string, string>;
    ownerAgentId?: string;
  },
  deps: ContinuationReturnDeliveryDeps = defaultContinuationReturnDeliveryDeps,
): Promise<{
  /** Durable rows written for current recipients, including any the full queue refused. */
  enqueued: number;
  /** Rows whose event reached the queue now; `enqueued - delivered` wait for the scheduler's retry. */
  delivered: number;
  deliveryIds: string[];
  /** Recipients whose event reached the queue now. */
  deliveredSessionKeys: string[];
  /** Recipients whose return the full queue refused; their rows are held for retry. */
  heldSessionKeys: string[];
  /** Recipients whose head a pending reset is replacing; the reset's resolution releases them. */
  resetHeldSessionKeys: string[];
  /** Recipients refused because their recipient authority advanced; nothing was delivered. */
  refusedSessionKeys: string[];
}> {
  if (!params.ownerAgentId) {
    throw new Error("Continuation return source owner is unavailable.");
  }
  const targetSessionKeys = normalizeContinuationTargetKeys(params.targetSessionKeys);
  const targets = targetSessionKeys.map((sessionKey) =>
    resolveContinuationReturnDeliveryTarget({
      sessionKey,
      recipientAgentIds: params.recipientAgentIds,
    }),
  );
  const deliveryIds: string[] = [];
  const deliveredSessionKeys: string[] = [];
  const heldSessionKeys: string[] = [];
  const resetHeldSessionKeys: string[] = [];
  const refusedSessionKeys: string[] = [];
  const recipientOutcomes: ContinuationFanoutRecipientOutcome[] = [];
  let delivered = 0;
  const returnWake: ContinuationReturnWake =
    params.returnWake ??
    (params.wakeRecipients
      ? {
          reason: "delegate-return",
          ...(params.childRunId ? { parentRunId: params.childRunId } : {}),
        }
      : false);

  for (const { sessionKey, recipientAgentId } of targets) {
    const text = params.text;
    const recipientAuthority = params.recipientAuthorities?.get(sessionKey);
    // Each decision runs under the recipient's authority read; an unbound return is current.
    const withAuthority = <T>(decide: (current: boolean) => T): Promise<T> =>
      recipientAuthority
        ? (deps.withRecipientAuthority ?? withRecipientAuthorityInWorker)(
            { sessionKey, agentId: recipientAgentId },
            recipientAuthority,
            decide,
          )
        : Promise.resolve(decide(true));
    const refuseStaleRecipient = async (deliveryId?: string) => {
      if (deliveryId) {
        await (deps.refuseDelivery ?? refuseContinuationReturnDelivery)(
          deliveryId,
          captureContinuationQueueContext(params.stateDir),
        );
      }
      refusedSessionKeys.push(sessionKey);
      recipientOutcomes.push("refused");
      reportRefusedContinuationReturn({
        stage: "enqueue",
        reason: "recipient-authority-changed",
        sessionKey,
        ...(deliveryId ? { deliveryId } : {}),
      });
    };
    if (!(await withAuthority((current) => current))) {
      await refuseStaleRecipient();
      continue;
    }
    const commonPayload = {
      kind: "systemEvent" as const,
      sessionKey,
      agentId: recipientAgentId,
      text,
      ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
      ...(params.traceparent ? { traceparent: params.traceparent } : {}),
      // Recipient position is not stable when a cleaned intermediate is
      // removed from a tree/all fanout. Keep retries keyed to the durable
      // recipient identity instead.
      idempotencyKey: `${params.idempotencyKeyBase}:${sessionKey}`,
    };
    // Every return settles only once a prompt adopts it, with or without
    // recipient authority: if the queue refuses the fast path, or the process
    // dies before adoption, the row is what replays the return.
    const payload: QueuedSessionDeliveryPayload = {
      ...commonPayload,
      ...(recipientAuthority ? { recipientAuthority } : {}),
      awaitPromptAdoption: true,
      // A retry that admits a held return wakes as this producer would have.
      returnWake,
      ...(params.childRunId ? { continuationSourceRunId: params.childRunId } : {}),
    };
    const deliveryId = await deps.enqueueSessionDelivery(
      payload,
      captureContinuationQueueContext(params.stateDir),
    );
    // The row's identity on its queued copy, normalized as claims and replay key it.
    const ackStateDir = resolveSessionDeliveryAckStateDir({
      sessionDeliveryAckId: deliveryId,
      sessionDeliveryAckStateDir: params.stateDir,
    });
    const enqueued = await withAuthority((current) => {
      if (!current) {
        return { kind: "stale" as const };
      }
      // Checked after the awaited write, with no await before the queue below: a reset that
      // marks the child later clears this event and its replay is deferred by the same mark.
      if (params.holdForReset?.(sessionKey)) {
        return { kind: "reset-held" as const };
      }
      const eventOptions = {
        sessionKey,
        trusted: true,
        ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
        ...(params.traceparent ? { traceparent: params.traceparent } : {}),
        sessionDeliveryAckId: deliveryId,
        ...(ackStateDir ? { sessionDeliveryAckStateDir: ackStateDir } : {}),
        ...(recipientAuthority ? { recipientAuthority } : {}),
        sessionDeliveryAwaitsTurnAdoption: true,
      };
      const ownedEventOptions = withContinuationOwner(eventOptions, recipientAgentId);
      // Never ack on `false`. It is either a de-duplicated re-enqueue (the
      // idempotent row already rides a queued event that carries its ack id) or a
      // capacity refusal (nothing is queued and the row is the only copy).
      return {
        kind: "queued" as const,
        refused:
          !deps.enqueueSystemEvent(text, ownedEventOptions) &&
          !hasQueuedSystemEventDelivery(ownedEventOptions),
      };
    });
    if (enqueued.kind === "stale") {
      // Stale authority can never adopt this row; retire it now rather than leave it until replay.
      await refuseStaleRecipient(deliveryId);
      continue;
    }
    if (enqueued.kind === "reset-held") {
      deliveryIds.push(deliveryId);
      resetHeldSessionKeys.push(sessionKey);
      recipientOutcomes.push("queued");
      log.info(
        `[continuation:return-held] session reset pending; deliveryId=${deliveryId} session=${sessionKey} waits for the reset to resolve`,
      );
      continue;
    }
    const { refused } = enqueued;
    const stillCurrent = await withAuthority((current) => {
      if (!current) {
        (deps.removeSystemEvents ?? removeSystemEvents)(
          sessionKey,
          (event) =>
            event.sessionDeliveryAckId === deliveryId &&
            event.sessionDeliveryAckStateDir === ackStateDir,
        );
      }
      return current;
    });
    if (!stillCurrent) {
      // Accepted edge: a turn that adopted the event inside this one read, before the revocation
      // committed, finds its row retired and its ack fails visibly; the model saw the return.
      await refuseStaleRecipient(deliveryId);
      continue;
    }
    deliveryIds.push(deliveryId);
    if (refused) {
      // Not delivered and not woken: a wake now would run a turn without the
      // return. The scheduler retries the row (deferred while the queue stays
      // full) and the replay that admits it wakes the recipient.
      heldSessionKeys.push(sessionKey);
      recipientOutcomes.push("queued");
      const armed = await (deps.scheduleSessionDelivery ?? scheduleRefusedReturnDelivery)(
        deliveryId,
        captureContinuationQueueContext(params.stateDir),
      );
      if (armed) {
        log.warn(
          `[continuation:return-held] system event queue full; deliveryId=${deliveryId} session=${sessionKey} retry armed`,
        );
      } else {
        reportUnarmedHeldReturn({ deliveryId, sessionKey, stateDir: params.stateDir });
      }
      continue;
    }
    if (params.wakeRecipients) {
      deps.requestContinuationWake({
        sessionKey,
        agentId: recipientAgentId,
        reason: "delegate-return",
        ...(params.childRunId ? { parentRunId: params.childRunId } : {}),
        deliveryIds: [deliveryId],
      });
    }
    // For a queued event, do NOT ack the durable file here. The in-memory event
    // carries the ack id; the woken turn (or the prompt-drain path) acknowledges it
    // only after adoption, and non-attached recipients still need restart recovery
    // to replay this file.
    delivered += 1;
    deliveredSessionKeys.push(sessionKey);
    recipientOutcomes.push("delivered");
  }

  if (
    (params.traceparent !== undefined || params.chainStepRemaining !== undefined) &&
    (params.fanoutMode !== undefined || targetSessionKeys.length > 1)
  ) {
    emitContinuationFanoutSpan({
      targetSessionKeys,
      recipientOutcomes,
      ...(refusedSessionKeys.length > 0 ? { refusalReason: "recipient-authority-changed" } : {}),
      ...(params.fanoutMode ? { fanoutMode: params.fanoutMode } : {}),
      ...(params.chainStepRemaining !== undefined
        ? { chainStepRemaining: params.chainStepRemaining }
        : {}),
      ...(params.traceparent ? { traceparent: params.traceparent } : {}),
    });
  }

  return {
    enqueued: deliveryIds.length,
    delivered,
    deliveryIds,
    deliveredSessionKeys,
    heldSessionKeys,
    resetHeldSessionKeys,
    refusedSessionKeys,
  };
}
