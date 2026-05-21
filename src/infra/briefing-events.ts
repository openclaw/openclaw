// Briefing event bus (D-GAP-2).
//
// `briefing.*` events are operator-visible summaries about a session that are
// surfaced once per occurrence — they are not a per-tool / per-turn telemetry
// stream like `diagnostic-events.ts`. Two variants land in this initial slice:
//
//   - `briefing.quarantine` — one batched briefing per `(sessionKey, channel)`
//     when inbound messages were quarantined (rejected, deferred, or held)
//     during a single processing pass. The emitter is `quarantine-briefing.ts`.
//   - `briefing.timeout` — one briefing per hung turn that was aborted by the
//     turn-timeout watchdog. The emitter is `turn-timeout.ts`.
//
// The bus is intentionally tiny: a typed listener set with synchronous
// dispatch, a process-local sequence counter, and an in-memory frozen-event
// clone for listener safety. Callers (logging, gateway operator surface,
// dashboards, tests) subscribe with `onBriefingEvent`. There is no async
// queue and no diagnostic-config gating; briefings are low-volume and the
// caller decides whether to emit at all.

import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type BriefingQuarantineReason =
  | "allowlist"
  | "rate_limit"
  | "schema"
  | "size"
  | "duplicate"
  | "policy"
  | "other";

export type BriefingQuarantineItem = {
  /** Stable identifier for the quarantined message within its batch. */
  itemId: string;
  /** Short human label (e.g. inbound message text excerpt). Optional. */
  label?: string;
  /** Classification used by the batcher and surfacing summary. */
  reason: BriefingQuarantineReason;
  /** Free-form detail string for logs/operator UI. Optional. */
  detail?: string;
};

type BriefingBaseEvent = {
  ts: number;
  seq: number;
  sessionKey: string;
  channel: string;
};

export type BriefingQuarantineEvent = BriefingBaseEvent & {
  type: "briefing.quarantine";
  /** Stable key identifying the batch this briefing covers. */
  batchKey: string;
  /** Number of distinct items in this batch (deduped by `itemId`). */
  itemCount: number;
  /** The deduped items in insertion order. */
  items: readonly BriefingQuarantineItem[];
  /** Aggregated per-reason counts for quick rendering. */
  reasonCounts: Readonly<Partial<Record<BriefingQuarantineReason, number>>>;
};

export type BriefingTimeoutEvent = BriefingBaseEvent & {
  type: "briefing.timeout";
  /** Stable key for the turn this briefing covers. */
  turnKey: string;
  /** Configured maxTurnMs at the time the watchdog fired. */
  maxTurnMs: number;
  /** Wall-clock duration the turn ran before abort, in milliseconds. */
  elapsedMs: number;
  /** Free-form detail (e.g. "abort dispatched", "abort dispatch failed: ..."). */
  detail?: string;
};

export type BriefingEvent = BriefingQuarantineEvent | BriefingTimeoutEvent;

export type BriefingEventInput =
  | Omit<BriefingQuarantineEvent, "seq" | "ts">
  | Omit<BriefingTimeoutEvent, "seq" | "ts">;

export type BriefingEventListener = (event: BriefingEvent) => void;

type BriefingEventsState = {
  seq: number;
  listeners: Set<BriefingEventListener>;
  dispatchDepth: number;
};

const BRIEFING_EVENTS_STATE_KEY = Symbol.for("openclaw.briefingEvents.state.v1");
const MAX_DISPATCH_DEPTH = 64;

function getState(): BriefingEventsState {
  return resolveGlobalSingleton<BriefingEventsState>(BRIEFING_EVENTS_STATE_KEY, () => ({
    seq: 0,
    listeners: new Set<BriefingEventListener>(),
    dispatchDepth: 0,
  }));
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (const item of value) {
      freezeDeep(item, seen);
    }
    return Object.freeze(value) as T;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freezeDeep(nested, seen);
  }
  return Object.freeze(value) as T;
}

function cloneForListener(event: BriefingEvent): BriefingEvent {
  return freezeDeep(structuredClone(event));
}

/** Subscribe to briefing events. Returns an unsubscribe function. */
export function onBriefingEvent(listener: BriefingEventListener): () => void {
  const state = getState();
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

/**
 * Emit a briefing event to all subscribers. Synchronous dispatch; a per-call
 * recursion guard caps depth so misbehaving listeners cannot deadlock.
 *
 * Each listener receives a frozen deep clone so mutations cannot leak across
 * subscribers.
 */
export function emitBriefingEvent(input: BriefingEventInput): BriefingEvent {
  const state = getState();
  state.seq += 1;
  const enriched: BriefingEvent = {
    ...input,
    seq: state.seq,
    ts: Date.now(),
  } as BriefingEvent;

  if (state.dispatchDepth > MAX_DISPATCH_DEPTH) {
    // Drop instead of crashing the producer.
    return enriched;
  }
  state.dispatchDepth += 1;
  try {
    for (const listener of state.listeners) {
      try {
        listener(cloneForListener(enriched));
      } catch (err) {
        const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
        console.error(
          `[briefing-events] listener error type=${enriched.type} seq=${enriched.seq}: ${message}`,
        );
      }
    }
  } finally {
    state.dispatchDepth -= 1;
  }
  return enriched;
}

export function resetBriefingEventsForTests(): void {
  const state = getState();
  state.seq = 0;
  state.listeners.clear();
  state.dispatchDepth = 0;
}
