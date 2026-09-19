// Lightweight in-memory queue for human-readable system events that should be
// prefixed to the next prompt. We intentionally avoid persistence to keep
// events ephemeral. Events are session-scoped and require an explicit key.

import { expectDefined } from "@openclaw/normalization-core";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { channelRouteDedupeKey } from "../plugin-sdk/channel-route.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolveGlobalMap, resolveGlobalSet } from "../shared/global-singleton.js";
import {
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { generateSecureUuid } from "./secure-random.js";

export type SystemEvent = {
  /**
   * OpenClaw-assigned opaque identity for one queued occurrence. Preserve it when returning a
   * snapshot to consume. It changes on replacement or re-enqueue; optional only for legacy
   * ID-less compatibility.
   */
  id?: string;
  text: string;
  ts: number;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
};

const MAX_EVENTS = 20;

type SessionQueue = {
  queue: SystemEvent[];
  lastContextKey: string | null;
};

const SYSTEM_EVENT_QUEUES_KEY = Symbol.for("openclaw.systemEvents.queues");

const queues = resolveGlobalMap<string, SessionQueue>(SYSTEM_EVENT_QUEUES_KEY, "close-and-restart");

/**
 * One consumer's reaction to a durable system event settling.
 *
 * Receives the globally-unique ids ({@link SystemEvent.id}) removed from a
 * session queue by any consumption path (steering ack, heartbeat settlement,
 * terminal poll, reset). A registered observer routes every consumer through a
 * single settlement point so consuming an occurrence on one path invalidates
 * the copies held by the others. Keyed on the durable id, never the reusable
 * `contextKey`, so a re-enqueued occurrence sharing a context cannot retire the
 * wrong copy.
 */
type SystemEventConsumptionObserver = (params: {
  sessionKey: string;
  consumedEventIds: readonly string[];
}) => void;

const SYSTEM_EVENT_CONSUMPTION_OBSERVERS_KEY = Symbol.for(
  "openclaw.systemEvents.consumptionObservers",
);

// A process-wide, lifecycle-owned set so duplicated runtime chunks share one
// settlement fan-out and a restart (or a test reset) clears stale observers
// instead of leaking them across files.
const consumptionObservers = resolveGlobalSet<SystemEventConsumptionObserver>(
  SYSTEM_EVENT_CONSUMPTION_OBSERVERS_KEY,
  "close-and-restart",
);

/**
 * Registers a settlement observer and returns a one-call unregister handle.
 *
 * Idempotent per callback identity: registering the same function twice keeps a
 * single membership. Consumers register lazily (on first use) so the observer
 * set is only populated in processes that actually settle exec completions.
 */
export function registerSystemEventConsumptionObserver(
  observer: SystemEventConsumptionObserver,
): () => void {
  consumptionObservers.add(observer);
  return () => {
    consumptionObservers.delete(observer);
  };
}

function notifySystemEventConsumption(sessionKey: string, consumed: readonly SystemEvent[]): void {
  if (consumptionObservers.size === 0) {
    return;
  }
  const consumedEventIds = consumed
    .map((event) => event.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (consumedEventIds.length === 0) {
    return;
  }
  for (const observer of consumptionObservers) {
    observer({ sessionKey, consumedEventIds });
  }
}

type SystemEventOptions = {
  sessionKey: string;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
  /** Replace the pending event for this context and delivery route. Requires contextKey. */
  replace?: boolean;
};

type ReceiptOptions = { allowDuplicate?: boolean };

function requireSessionKey(key?: string | null): string {
  const trimmed = normalizeOptionalString(key) ?? "";
  const parsed = parseAgentSessionKey(trimmed);
  if (!parsed) {
    throw new Error("system events require an agent-qualified sessionKey");
  }
  return `agent:${parsed.agentId}:${parsed.rest}`;
}

function normalizeContextKey(key?: string | null): string | null {
  return normalizeOptionalLowercaseString(key) ?? null;
}

function getSessionQueue(sessionKey: string): SessionQueue | undefined {
  return queues.get(requireSessionKey(sessionKey));
}

function getOrCreateSessionQueue(key: string): SessionQueue {
  const existing = queues.get(key);
  if (existing) {
    return existing;
  }
  const created: SessionQueue = {
    queue: [],
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

export function enqueueSystemEventEntry(
  text: string,
  options: SystemEventOptions,
): SystemEvent | null {
  const event = enqueueOwnedSystemEventEntry(text, options);
  return event ? cloneSystemEvent(event) : null;
}

function enqueueOwnedSystemEventEntry(
  text: string,
  options: SystemEventOptions,
  receiptOptions?: ReceiptOptions,
): SystemEvent | null {
  const key = requireSessionKey(options.sessionKey);
  const entry = getOrCreateSessionQueue(key);
  const cleaned = text.trim();
  if (!cleaned) {
    return null;
  }
  const normalizedContextKey = normalizeContextKey(options.contextKey);
  const normalizedDeliveryContext = normalizeDeliveryContext(options.deliveryContext);
  const matches = (event: SystemEvent) =>
    (event.contextKey ?? null) === normalizedContextKey &&
    areDeliveryContextsEqual(event.deliveryContext, normalizedDeliveryContext);
  if (options.replace) {
    if (normalizedContextKey === null) {
      throw new Error("replaced system events require a contextKey");
    }
    const matching = entry.queue.filter(matches);
    if (matching.length === 1 && matching[0]?.text === cleaned) {
      return null;
    }
    // Replacements move to the end without evicting unrelated sources.
    entry.queue = entry.queue.filter((event) => !matches(event));
  } else if (receiptOptions?.allowDuplicate !== true) {
    const duplicate = (event: SystemEvent | undefined) =>
      event !== undefined && event.text === cleaned && matches(event);
    if (
      normalizedContextKey === null ? duplicate(entry.queue.at(-1)) : entry.queue.some(duplicate)
    ) {
      return null;
    }
  }
  if (normalizedContextKey !== null) {
    entry.lastContextKey = normalizedContextKey;
  }
  const event: SystemEvent = {
    id: generateSecureUuid(),
    text: cleaned,
    ts: Date.now(),
    contextKey: normalizedContextKey,
    deliveryContext: normalizedDeliveryContext,
  };
  entry.queue.push(event);
  if (entry.queue.length > MAX_EVENTS) {
    entry.queue.shift();
  }
  return event;
}

export function enqueueSystemEvent(text: string, options: SystemEventOptions) {
  return enqueueOwnedSystemEventEntry(text, options) !== null;
}

/** Enqueues one occurrence and returns one-use removal ownership for its UUID. */
export function enqueueSystemEventWithReceipt(
  text: string,
  options: SystemEventOptions,
  receiptOptions?: ReceiptOptions,
): (() => boolean) | null {
  return enqueueSystemEventReceipt(text, options, receiptOptions)?.remove ?? null;
}

/** One durable occurrence's globally-unique id plus its one-use removal handle. */
export type SystemEventReceipt = {
  /** Globally-unique id ({@link SystemEvent.id}) of the enqueued occurrence. */
  eventId: string;
  /** Removes exactly this occurrence by its id; returns true if it was still queued. */
  remove: () => boolean;
};

/**
 * Enqueues one occurrence and returns its durable id alongside a one-use
 * removal handle keyed on that id.
 *
 * Exposing the id lets a second representation (the exec steering copy) bind to
 * the same globally-unique identity instead of the reusable `contextKey`, so
 * settling one representation retires exactly the other and never a re-enqueued
 * occurrence that happens to share a context.
 */
export function enqueueSystemEventReceipt(
  text: string,
  options: SystemEventOptions,
  receiptOptions?: ReceiptOptions,
): SystemEventReceipt | null {
  const event = enqueueOwnedSystemEventEntry(text, options, receiptOptions);
  if (!event || event.id === undefined) {
    return null;
  }
  const sessionKey = requireSessionKey(options.sessionKey);
  const eventId = event.id;
  return {
    eventId,
    remove: () => consumeSelectedSystemEventEntries(sessionKey, [event]).length > 0,
  };
}

export function drainSystemEventEntries(sessionKey: string): SystemEvent[] {
  return drainSystemEventsWith(sessionKey, cloneSystemEvent);
}

function drainSystemEventsWith<T>(sessionKey: string, project: (event: SystemEvent) => T): T[] {
  const key = requireSessionKey(sessionKey);
  const entry = queues.get(key);
  if (!entry || entry.queue.length === 0) {
    return [];
  }
  const drained = entry.queue.slice();
  const out = entry.queue.map(project);
  // Reentrant consumers may hold this array; clear it in place before removing the queue.
  entry.queue.length = 0;
  entry.lastContextKey = null;
  queues.delete(key);
  notifySystemEventConsumption(key, drained);
  return out;
}

function areDeliveryContextsEqual(left?: DeliveryContext, right?: DeliveryContext): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return channelRouteDedupeKey(left) === channelRouteDedupeKey(right);
}

function areLegacySystemEventsEqual(left: SystemEvent, right: SystemEvent): boolean {
  return (
    left.text === right.text &&
    left.ts === right.ts &&
    (left.contextKey ?? null) === (right.contextKey ?? null) &&
    areDeliveryContextsEqual(left.deliveryContext, right.deliveryContext)
  );
}

function matchesConsumedSystemEvent(queued: SystemEvent, consumed: SystemEvent): boolean {
  if (consumed.id !== undefined) {
    // Queue-owned IDs govern modern consumption; only legacy ID-less snapshots use structure.
    return queued.id === consumed.id;
  }
  return areLegacySystemEventsEqual(queued, consumed);
}

function resetQueueState(key: string, entry: SessionQueue) {
  if (entry.queue.length === 0) {
    entry.lastContextKey = null;
    queues.delete(key);
    return;
  }
  for (let index = entry.queue.length - 1; index >= 0; index -= 1) {
    const contextKey = expectDefined(entry.queue[index], "queue entry at index").contextKey ?? null;
    if (contextKey !== null) {
      entry.lastContextKey = contextKey;
      return;
    }
  }
  entry.lastContextKey = null;
}

export function consumeSelectedSystemEventEntries(
  sessionKey: string,
  consumedEntries: readonly SystemEvent[],
): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = queues.get(key);
  if (!entry || entry.queue.length === 0 || consumedEntries.length === 0) {
    return [];
  }
  const removed: SystemEvent[] = [];
  for (const consumed of consumedEntries) {
    const index = entry.queue.findIndex((event) => matchesConsumedSystemEvent(event, consumed));
    if (index === -1) {
      continue;
    }
    const [event] = entry.queue.splice(index, 1);
    if (event) {
      removed.push(cloneSystemEvent(event));
    }
  }
  resetQueueState(key, entry);
  // A single settlement fan-out: any consumer removing an occurrence lets the
  // others invalidate their copies of the same durable id.
  notifySystemEventConsumption(key, removed);
  return removed;
}

export function drainSystemEvents(sessionKey: string): string[] {
  return drainSystemEventsWith(sessionKey, (event) => event.text);
}

/**
 * Removes every pending event for one context key under a session queue.
 *
 * Used to retire a durable completion event once its shared steering copy has
 * been delivered, so a later heartbeat cannot re-deliver the same occurrence.
 * Returns the number of events removed.
 */
export function removeSystemEventsByContextKey(sessionKey: string, contextKey: string): number {
  const entry = getSessionQueue(sessionKey);
  if (!entry || entry.queue.length === 0) {
    return 0;
  }
  const key = requireSessionKey(sessionKey);
  const normalized = normalizeContextKey(contextKey);
  if (normalized === null) {
    return 0;
  }
  const matching = entry.queue.filter((event) => (event.contextKey ?? null) === normalized);
  if (matching.length === 0) {
    return 0;
  }
  return consumeSelectedSystemEventEntries(key, matching).length;
}

export function peekSystemEventEntries(sessionKey: string): SystemEvent[] {
  return getSessionQueue(sessionKey)?.queue.map(cloneSystemEvent) ?? [];
}

export function peekSystemEvents(sessionKey: string): string[] {
  return getSessionQueue(sessionKey)?.queue.map((event) => event.text) ?? [];
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

export function resetSystemEventsForTest() {
  queues.clear();
  // Clear settlement observers too: the observer set is a module-global
  // singleton, so a consumer registered in one test file would otherwise leak
  // into the next and fire against its unrelated queues. Resetting here keeps
  // the fan-out scoped to whichever test currently owns it.
  consumptionObservers.clear();
}
