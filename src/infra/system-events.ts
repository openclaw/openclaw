// Lightweight in-memory queue for human-readable system events that should be
// prefixed to the next prompt. We intentionally avoid persistence to keep
// events ephemeral. Events are session-scoped and require an explicit key.

import { resolveGlobalMap } from "../shared/global-singleton.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import {
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

export type SystemEvent = {
  text: string;
  ts: number;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
  trusted?: boolean;
  /**
   * When true, periodic heartbeats (interval/retry) should drain this event as
   * part of selective drain — treat the event as an active wake signal rather
   * than a passive state update queued for the next user turn.
   *
   * Typically set by producers that expect a heartbeat to surface the event
   * soon (exec completions, cron results, hook wakes, task updates). Producers
   * often pair the enqueue with a requestHeartbeatNow() call, but the flag
   * itself is independent: producers using mode "next-heartbeat" still set it
   * so the next periodic run picks up the event.
   */
  wakeRequested?: boolean;
  /**
   * Identifier of the logical source (e.g. a bash process session id) that
   * emitted the event. Used by removeExecEventsForSession to target cleanup
   * by exact id rather than matching against text prefixes, which is
   * susceptible to collisions when distinct sessions share a prefix.
   */
  sourceSessionId?: string;
};

const MAX_EVENTS = 20;

type SessionQueue = {
  queue: SystemEvent[];
  lastText: string | null;
  lastContextKey: string | null;
};

const SYSTEM_EVENT_QUEUES_KEY = Symbol.for("openclaw.systemEvents.queues");

const queues = resolveGlobalMap<string, SessionQueue>(SYSTEM_EVENT_QUEUES_KEY);

type SystemEventOptions = {
  sessionKey: string;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
  trusted?: boolean;
  /**
   * When true, mark the event for selective drain on periodic heartbeats.
   * See the SystemEvent.wakeRequested docstring for full semantics.
   */
  wakeRequested?: boolean;
  /**
   * Optional source-session identifier propagated onto the queued event.
   * Enables later cleanup-by-source via removeExecEventsForSession.
   */
  sourceSessionId?: string;
};

function requireSessionKey(key?: string | null): string {
  const trimmed = normalizeOptionalString(key) ?? "";
  if (!trimmed) {
    throw new Error("system events require a sessionKey");
  }
  return trimmed;
}

function normalizeContextKey(key?: string | null): string | null {
  return normalizeOptionalLowercaseString(key) ?? null;
}

function getSessionQueue(sessionKey: string): SessionQueue | undefined {
  return queues.get(requireSessionKey(sessionKey));
}

function getOrCreateSessionQueue(sessionKey: string): SessionQueue {
  const key = requireSessionKey(sessionKey);
  const existing = queues.get(key);
  if (existing) {
    return existing;
  }
  const created: SessionQueue = {
    queue: [],
    lastText: null,
    lastContextKey: null,
  };
  queues.set(key, created);
  return created;
}

function cloneSystemEvent(event: SystemEvent): SystemEvent {
  return {
    ...event,
    ...(event.deliveryContext ? { deliveryContext: { ...event.deliveryContext } } : {}),
  };
}

export function isSystemEventContextChanged(
  sessionKey: string,
  contextKey?: string | null,
): boolean {
  const existing = getSessionQueue(sessionKey);
  const normalized = normalizeContextKey(contextKey);
  return normalized !== (existing?.lastContextKey ?? null);
}

export function enqueueSystemEvent(text: string, options: SystemEventOptions) {
  const key = requireSessionKey(options?.sessionKey);
  const entry = getOrCreateSessionQueue(key);
  const cleaned = text.trim();
  if (!cleaned) {
    return false;
  }
  const normalizedContextKey = normalizeContextKey(options?.contextKey);
  const normalizedDeliveryContext = normalizeDeliveryContext(options?.deliveryContext);
  entry.lastContextKey = normalizedContextKey;
  if (entry.lastText === cleaned) {
    return false;
  } // skip consecutive duplicates
  entry.lastText = cleaned;
  entry.queue.push({
    text: cleaned,
    ts: Date.now(),
    contextKey: normalizedContextKey,
    deliveryContext: normalizedDeliveryContext,
    trusted: options.trusted !== false,
    ...(options.wakeRequested ? { wakeRequested: true } : {}),
    ...(options.sourceSessionId ? { sourceSessionId: options.sourceSessionId } : {}),
  });
  if (entry.queue.length > MAX_EVENTS) {
    entry.queue.shift();
  }
  return true;
}

export function drainSystemEventEntries(sessionKey: string): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = getSessionQueue(key);
  if (!entry || entry.queue.length === 0) {
    return [];
  }
  const out = entry.queue.map(cloneSystemEvent);
  entry.queue.length = 0;
  entry.lastText = null;
  entry.lastContextKey = null;
  queues.delete(key);
  return out;
}

function areDeliveryContextsEqual(left?: DeliveryContext, right?: DeliveryContext): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    (left.channel ?? undefined) === (right.channel ?? undefined) &&
    (left.to ?? undefined) === (right.to ?? undefined) &&
    (left.threadId ?? undefined) === (right.threadId ?? undefined)
  );
}

function areSystemEventsEqual(left: SystemEvent, right: SystemEvent): boolean {
  return (
    left.text === right.text &&
    left.ts === right.ts &&
    (left.contextKey ?? null) === (right.contextKey ?? null) &&
    (left.trusted ?? true) === (right.trusted ?? true) &&
    areDeliveryContextsEqual(left.deliveryContext, right.deliveryContext)
  );
}

export function consumeSystemEventEntries(
  sessionKey: string,
  consumedEntries: readonly SystemEvent[],
): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = getSessionQueue(key);
  if (!entry || entry.queue.length === 0 || consumedEntries.length === 0) {
    return [];
  }
  if (
    consumedEntries.length > entry.queue.length ||
    !consumedEntries.every((event, index) => areSystemEventsEqual(entry.queue[index], event))
  ) {
    return [];
  }
  const removed = entry.queue.splice(0, consumedEntries.length).map(cloneSystemEvent);
  if (entry.queue.length === 0) {
    entry.lastText = null;
    entry.lastContextKey = null;
    queues.delete(key);
  } else {
    const newest = entry.queue[entry.queue.length - 1];
    entry.lastText = newest.text;
    entry.lastContextKey = newest.contextKey ?? null;
  }
  return removed;
}

/**
 * Drain only events tagged with `wakeRequested`, leaving the rest queued.
 * Used by periodic heartbeats to pick up events whose dedicated wake was
 * missed without consuming presence/config events meant for the next user turn.
 */
export function drainWakeRequestedEvents(sessionKey: string): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = getSessionQueue(key);
  if (!entry || entry.queue.length === 0) {
    return [];
  }
  const wakeEvents: SystemEvent[] = [];
  const remaining: SystemEvent[] = [];
  for (const event of entry.queue) {
    if (event.wakeRequested) {
      wakeEvents.push(cloneSystemEvent(event));
    } else {
      remaining.push(event);
    }
  }
  if (wakeEvents.length === 0) {
    return [];
  }
  entry.queue.length = 0;
  entry.queue.push(...remaining);
  if (entry.queue.length === 0) {
    entry.lastText = null;
    entry.lastContextKey = null;
    queues.delete(key);
  } else {
    // Update dedupe markers to match the remaining queue tail so future
    // enqueues that reuse a drained event's text are not incorrectly
    // suppressed as consecutive duplicates.
    const tail = remaining[remaining.length - 1];
    entry.lastText = tail.text;
    entry.lastContextKey = tail.contextKey ?? null;
  }
  return wakeEvents;
}

export function peekWakeRequestedEvents(sessionKey: string): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = getSessionQueue(key);
  if (!entry || entry.queue.length === 0) {
    return [];
  }
  return entry.queue.filter((event) => event.wakeRequested).map((event) => cloneSystemEvent(event));
}

export function drainSystemEvents(sessionKey: string): string[] {
  return drainSystemEventEntries(sessionKey).map((event) => event.text);
}

export function peekSystemEventEntries(sessionKey: string): SystemEvent[] {
  return getSessionQueue(sessionKey)?.queue.map(cloneSystemEvent) ?? [];
}

export function peekSystemEvents(sessionKey: string): string[] {
  return peekSystemEventEntries(sessionKey).map((event) => event.text);
}

export function hasSystemEvents(sessionKey: string) {
  return (getSessionQueue(sessionKey)?.queue.length ?? 0) > 0;
}

export function resolveSystemEventDeliveryContext(
  events: readonly SystemEvent[],
): DeliveryContext | undefined {
  let resolved: DeliveryContext | undefined;
  for (const event of events) {
    resolved = mergeDeliveryContext(event.deliveryContext, resolved);
  }
  return resolved;
}

/**
 * Remove events from a session queue that match a predicate. Unlike
 * consumeSystemEventEntries (which requires a strict queue-head prefix
 * match), this removes matching events regardless of their position,
 * keeping non-matching events in their original order.
 *
 * Intended for the narrow case where a run needs to drain a subset of a
 * shared queue — for example, an isolated-session heartbeat consuming
 * only the cross-session cron events visible via the base queue without
 * disturbing base-queue events meant for the next user turn.
 *
 * Returns the removed events (cloned).
 */
export function removeSystemEventsMatching(
  sessionKey: string,
  predicate: (event: SystemEvent) => boolean,
): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = getSessionQueue(key);
  if (!entry || entry.queue.length === 0) {
    return [];
  }
  const removed: SystemEvent[] = [];
  const remaining: SystemEvent[] = [];
  for (const event of entry.queue) {
    if (predicate(event)) {
      removed.push(cloneSystemEvent(event));
    } else {
      remaining.push(event);
    }
  }
  if (removed.length === 0) {
    return [];
  }
  entry.queue.length = 0;
  entry.queue.push(...remaining);
  if (entry.queue.length === 0) {
    entry.lastText = null;
    entry.lastContextKey = null;
    queues.delete(key);
  } else {
    // Update dedupe markers to the new queue tail so a future enqueue that
    // reuses a removed event's text is not incorrectly suppressed as a
    // consecutive duplicate.
    const tail = entry.queue[entry.queue.length - 1];
    entry.lastText = tail.text;
    entry.lastContextKey = tail.contextKey ?? null;
  }
  return removed;
}

/**
 * Remove queued exec-completion events for a specific process session.
 * Used as a fallback cleanup when poll returns an exit result — if
 * maybeNotifyOnExit raced ahead of the pollWaiting counter and already
 * enqueued an event, this removes the now-redundant notification.
 *
 * Matches by the sourceSessionId field on queued events, which is set by
 * the producer (maybeNotifyOnExit / emitExecSystemEvent) to the full
 * bash process session id. This avoids the collision risk of matching
 * against an 8-character prefix embedded in event text.
 */
export function removeExecEventsForSession(sessionKey: string, sessionId: string): number {
  if (!sessionId) {
    return 0;
  }
  return removeSystemEventsMatching(sessionKey, (event) => event.sourceSessionId === sessionId)
    .length;
}

export function resetSystemEventsForTest() {
  queues.clear();
}
