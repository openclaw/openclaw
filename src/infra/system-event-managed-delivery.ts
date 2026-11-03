// Continuation (karmaterminal): managed delivery fields on system events. A continuation return
// rides a durable session-delivery row (ack id + state dir) and may name the session and recipient
// authority it was produced for. system-events.ts owns the queue and calls these at enqueue,
// consume and restore; only restore rewrites the queue entry it is handed.
import type { SessionRecipientAuthority } from "../config/sessions/session-recipient-authority-types.js";
import { resolveStateDir } from "../config/state-dir.js";
import { normalizeDiagnosticTraceparent } from "./diagnostic-trace-context.js";
import {
  isDeliveryAdoptionClaimed,
  releaseSystemEventDeliveryAdoption,
} from "./system-event-delivery-claims.js";
import { getSystemEventStorePath, isSystemEventStoreCurrent } from "./system-event-ownership.js";

export { resetSystemEventDeliveryAdoptionClaimsForTest as resetForTest } from "./system-event-delivery-claims.js";

export type ManagedSystemEventOptions = {
  sessionDeliveryAckId?: string;
  sessionDeliveryAckStateDir?: string;
  /** Defer the durable ack to turn adoption; see the SystemEvent field. */
  sessionDeliveryAwaitsTurnAdoption?: boolean;
  expectedSessionId?: string;
  recipientAuthority?: SessionRecipientAuthority;
  /**
   * Trusted-internal enrichment marker. Only core producers may attach managed
   * delivery provenance such as expectedSessionId and recipientAuthority.
   */
  trusted?: boolean;
  /**
   * Optional W3C `traceparent` to attach to the queued event for cross-boundary
   * trace correlation. Invalid values are silently dropped (additive contract:
   * a malformed traceparent never prevents an enqueue).
   */
  traceparent?: string;
};

/** Managed-delivery provenance a queued system event carries (see SystemEvent in system-events.ts). */
export type ManagedSystemEventFields = {
  sessionDeliveryAckId?: string;
  sessionDeliveryAckStateDir?: string;
  /**
   * Acknowledge the durable row only once the prepared turn is durably adopted,
   * instead of during prompt preparation, for events whose producer cannot
   * reconstruct the notice after the durable row is gone.
   */
  sessionDeliveryAwaitsTurnAdoption?: boolean;
  expectedSessionId?: string;
  recipientAuthority?: SessionRecipientAuthority;
  /**
   * W3C `traceparent` captured at enqueue-time so the substrate-queue drain can
   * reconstruct the producer trace at announce/deliver time. Per RFC §6.7
   * (docs/design/continue-work-signal-v2.md) the substrate queue is an asynchronous
   * boundary (enqueue turn != drain turn, possibly across a gateway restart), so
   * trace context rides on the payload itself rather than on a runtime ambient.
   * Optional and additive — invalid traceparent values are silently dropped at
   * enqueue-time so producers never fail-the-write on a malformed header.
   */
  traceparent?: string;
};

/** The queued-event shape these helpers read; system-events.ts passes its SystemEvent. */
type ManagedEvent = ManagedSystemEventFields & {
  id?: string;
  text: string;
  sessionStorePath?: string | null;
};

export function resolveSessionDeliveryAckStateDir(
  options: Pick<ManagedSystemEventOptions, "sessionDeliveryAckId" | "sessionDeliveryAckStateDir">,
): string | undefined {
  if (!options.sessionDeliveryAckId) {
    return undefined;
  }
  // Explicit and ambient paths can name the same durable row across restart. Normalize to the
  // state dir the queue's worker context resolves, so a stored event, its adoption claim and a
  // replay's lookup share one key: one prompt slot, and replay sees a turn adopting the row.
  return resolveStateDir(
    options.sessionDeliveryAckStateDir
      ? { ...process.env, OPENCLAW_STATE_DIR: options.sessionDeliveryAckStateDir }
      : process.env,
  );
}

/** Managed fields of a new event. A keyed replacement never defers its ack to turn adoption. */
export function fields(
  options: ManagedSystemEventOptions & { replace?: boolean },
): ManagedSystemEventFields {
  const sessionDeliveryAckStateDir = resolveSessionDeliveryAckStateDir(options);
  const traceparent = normalizeDiagnosticTraceparent(options.traceparent);
  const trusted = options.trusted === true;
  return {
    ...(options.sessionDeliveryAckId ? { sessionDeliveryAckId: options.sessionDeliveryAckId } : {}),
    ...(sessionDeliveryAckStateDir ? { sessionDeliveryAckStateDir } : {}),
    ...(trusted && options.sessionDeliveryAwaitsTurnAdoption && !options.replace
      ? { sessionDeliveryAwaitsTurnAdoption: true }
      : {}),
    ...(trusted && options.expectedSessionId
      ? { expectedSessionId: options.expectedSessionId }
      : {}),
    ...(trusted && options.recipientAuthority
      ? { recipientAuthority: { ...options.recipientAuthority } }
      : {}),
    ...(traceparent ? { traceparent } : {}),
  };
}

function areRecipientAuthoritiesEqual(
  left?: SessionRecipientAuthority,
  right?: SessionRecipientAuthority,
): boolean {
  return (
    left?.state === right?.state &&
    (left?.state !== "bound" || (right?.state === "bound" && left.epoch === right.epoch))
  );
}

/**
 * Same durable row, expected session and recipient authority: the managed half of duplicate
 * detection. A keyed replacement and a consumed snapshot also compare the traceparent.
 */
export function isSame(
  left: ManagedSystemEventFields,
  right: ManagedSystemEventFields,
  compareTraceparent = false,
) {
  return (
    left.sessionDeliveryAckId === right.sessionDeliveryAckId &&
    left.sessionDeliveryAckStateDir === right.sessionDeliveryAckStateDir &&
    left.expectedSessionId === right.expectedSessionId &&
    areRecipientAuthoritiesEqual(left.recipientAuthority, right.recipientAuthority) &&
    (!compareTraceparent || (left.traceparent ?? undefined) === (right.traceparent ?? undefined))
  );
}

/** Whether a queued event duplicates this enqueue: same text, the queue's own match, same delivery. */
export function sameAs<E extends ManagedEvent>(
  options: ManagedSystemEventOptions & { replace?: boolean },
  text: string,
  matches: (event: E) => boolean,
): (event: E) => boolean {
  const incoming = fields(options);
  return (event) =>
    event.text === text && matches(event) && isSame(event, incoming, options.replace === true);
}

/**
 * Where an unkeyed enqueue of a durable row lands. null: refuse it, because a prepared turn is
 * adopting (or already adopted) the row, or its queued copy already matches; re-queueing would
 * surface the same delivery in a second prompt. A slot: the queued copy of the same row, which
 * the new event replaces in place, past duplicate and capacity checks. undefined: no durable copy.
 */
export function resolveSlot<E extends ManagedEvent>(
  options: ManagedSystemEventOptions & { replace?: boolean },
  queue: readonly E[],
  same: (queued: E) => boolean,
): { index: number; existing: E } | null | undefined {
  const ackId = options.sessionDeliveryAckId;
  if (options.replace || !ackId) {
    return undefined;
  }
  const stateDir = resolveSessionDeliveryAckStateDir(options);
  if (isDeliveryAdoptionClaimed(ackId, stateDir)) {
    return null;
  }
  // An ack id + state dir identifies ONE persisted row, so the slot is located
  // by that identity alone: a re-enqueue of the same durable row replaces its
  // slot instead of double-queueing it.
  const index = queue.findIndex(
    (queued) =>
      queued.sessionDeliveryAckId === ackId && queued.sessionDeliveryAckStateDir === stateDir,
  );
  const existing = queue[index];
  if (!existing) {
    return undefined;
  }
  return same(existing) ? null : { index, existing };
}

/**
 * Consumed entries a consumer gives back, put at the head of the queue in their original order.
 * The consuming turn's claims end whether or not an entry is restored (a replaced store leaves the
 * row to replay); an entry already queued again (same id or durable row) is skipped. To bring the
 * queue back to `maxEvents`, the oldest entries without a durable row are evicted: dropping a
 * durable-backed entry from memory would lose the return until gateway restart, so the queue may
 * exceed the cap only by such entries.
 */
export function restore<E extends ManagedEvent>(
  sessionKey: string,
  entry: { queue: E[] },
  events: readonly E[],
  clone: (event: E) => E,
  maxEvents: number,
): E[] {
  for (const event of events) {
    releaseSystemEventDeliveryAdoption(event, { settled: false });
  }
  const restored = events.filter(
    (event) =>
      isSystemEventStoreCurrent(
        sessionKey,
        event.sessionStorePath ?? getSystemEventStorePath(sessionKey),
      ) &&
      !entry.queue.some(
        (queued) =>
          (event.id !== undefined && queued.id === event.id) ||
          (event.sessionDeliveryAckId !== undefined &&
            queued.sessionDeliveryAckId === event.sessionDeliveryAckId &&
            queued.sessionDeliveryAckStateDir === event.sessionDeliveryAckStateDir),
      ),
  );
  entry.queue.unshift(...restored.map(clone));
  let overflow = entry.queue.length - maxEvents;
  const evicted: E[] = [];
  if (overflow > 0) {
    entry.queue = entry.queue.filter((event) => {
      if (overflow > 0 && !event.sessionDeliveryAckId) {
        overflow -= 1;
        evicted.push(event);
        return false;
      }
      return true;
    });
  }
  return evicted;
}
