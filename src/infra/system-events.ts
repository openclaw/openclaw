// Lightweight in-memory queue for human-readable system events that should be
// prefixed to the next prompt. We intentionally avoid persistence to keep
// events ephemeral. Events are session-scoped and require an explicit key.

import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { channelRouteDedupeKey } from "../plugin-sdk/channel-route.js";
import { sanitizeInboundSystemTags } from "../security/system-tags.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
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
  deliveryQueueIds?: string[];
  disableTools?: boolean;
};

const MAX_EVENTS = 20;

type SessionQueue = {
  queue: SystemEvent[];
  lastContextKey: string | null;
};

const SYSTEM_EVENT_QUEUES_KEY = Symbol.for("openclaw.systemEvents.queues");
const CONSUMED_SYSTEM_EVENT_DELIVERIES_KEY = Symbol.for("openclaw.systemEvents.consumedDeliveries");

const queues = resolveGlobalMap<string, SessionQueue>(SYSTEM_EVENT_QUEUES_KEY);
const consumedDeliveryQueueIds = resolveGlobalMap<string, Set<string>>(
  CONSUMED_SYSTEM_EVENT_DELIVERIES_KEY,
);

type SystemEventOptions = {
  sessionKey: string;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
  deliveryQueueId?: string;
  disableTools?: boolean;
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
    lastContextKey: null,
  };
  queues.set(key, created);
  return created;
}

function cloneSystemEvent(event: SystemEvent): SystemEvent {
  return {
    ...event,
    ...(event.deliveryContext ? { deliveryContext: { ...event.deliveryContext } } : {}),
    ...(event.deliveryQueueIds ? { deliveryQueueIds: [...event.deliveryQueueIds] } : {}),
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

function findDuplicateInQueue(
  queue: readonly SystemEvent[],
  text: string,
  contextKey: string | null,
  deliveryContext: DeliveryContext | undefined,
): SystemEvent | undefined {
  const incoming = { text, contextKey, deliveryContext };
  if (contextKey === null) {
    const last = queue[queue.length - 1];
    return last && isDuplicateSystemEvent(last, incoming) ? last : undefined;
  }
  return queue.find((event) => isDuplicateSystemEvent(event, incoming));
}

export function enqueueSystemEventEntry(
  text: string,
  options: SystemEventOptions,
): SystemEvent | null {
  const key = requireSessionKey(options.sessionKey);
  const entry = getOrCreateSessionQueue(key);
  // These entries are rendered as `System:` lines, so strip nested system-marker
  // spoofs at the queue boundary before any plugin/channel text reaches a prompt.
  const cleaned = sanitizeInboundSystemTags(text).trim();
  if (!cleaned) {
    return null;
  }
  const normalizedContextKey = normalizeContextKey(options.contextKey);
  const normalizedDeliveryContext = normalizeDeliveryContext(options.deliveryContext);
  const deliveryQueueId = normalizeOptionalString(options.deliveryQueueId);
  const duplicate = findDuplicateInQueue(
    entry.queue,
    cleaned,
    normalizedContextKey,
    normalizedDeliveryContext,
  );
  if (duplicate) {
    if (deliveryQueueId && !duplicate.deliveryQueueIds?.includes(deliveryQueueId)) {
      duplicate.deliveryQueueIds = [...(duplicate.deliveryQueueIds ?? []), deliveryQueueId];
    }
    if (options.disableTools === true) {
      duplicate.disableTools = true;
    }
    return null;
  }
  if (normalizedContextKey !== null) {
    entry.lastContextKey = normalizedContextKey;
  }
  const event: SystemEvent = {
    text: cleaned,
    ts: Date.now(),
    contextKey: normalizedContextKey,
    deliveryContext: normalizedDeliveryContext,
    ...(deliveryQueueId ? { deliveryQueueIds: [deliveryQueueId] } : {}),
    ...(options.disableTools === true ? { disableTools: true } : {}),
  };
  entry.queue.push(event);
  if (entry.queue.length > MAX_EVENTS) {
    const ephemeralIndex = entry.queue.findIndex(
      (queuedEvent) => (queuedEvent.deliveryQueueIds?.length ?? 0) === 0,
    );
    const evictionIndex = ephemeralIndex >= 0 ? ephemeralIndex : entry.queue.length - 1;
    const retained = entry.queue[evictionIndex] !== event;
    entry.queue.splice(evictionIndex, 1);
    resetQueueState(key, entry);
    if (!retained) {
      return null;
    }
  }
  return cloneSystemEvent(event);
}

export function enqueueSystemEvent(text: string, options: SystemEventOptions) {
  return enqueueSystemEventEntry(text, options) !== null;
}

export function drainSystemEventEntries(sessionKey: string): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = getSessionQueue(key);
  if (!entry || entry.queue.length === 0) {
    return [];
  }
  const out = entry.queue.map(cloneSystemEvent);
  entry.queue.length = 0;
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
  return channelRouteDedupeKey(left) === channelRouteDedupeKey(right);
}

function isDuplicateSystemEvent(
  existing: SystemEvent,
  incoming: Pick<SystemEvent, "text" | "contextKey" | "deliveryContext">,
): boolean {
  return (
    existing.text === incoming.text &&
    (existing.contextKey ?? null) === (incoming.contextKey ?? null) &&
    areDeliveryContextsEqual(existing.deliveryContext, incoming.deliveryContext)
  );
}

function areSystemEventsEqual(left: SystemEvent, right: SystemEvent): boolean {
  return (
    left.text === right.text &&
    left.ts === right.ts &&
    (left.contextKey ?? null) === (right.contextKey ?? null) &&
    areDeliveryContextsEqual(left.deliveryContext, right.deliveryContext) &&
    JSON.stringify(left.deliveryQueueIds ?? []) === JSON.stringify(right.deliveryQueueIds ?? []) &&
    left.disableTools === right.disableTools
  );
}

function recordConsumedDeliveryQueueIds(sessionKey: string, events: readonly SystemEvent[]): void {
  const ids = events.flatMap((event) => event.deliveryQueueIds ?? []);
  if (ids.length === 0) {
    return;
  }
  const pending = consumedDeliveryQueueIds.get(sessionKey) ?? new Set<string>();
  for (const id of ids) {
    pending.add(id);
  }
  consumedDeliveryQueueIds.set(sessionKey, pending);
}

function resetQueueState(key: string, entry: SessionQueue) {
  if (entry.queue.length === 0) {
    entry.lastContextKey = null;
    queues.delete(key);
    return;
  }
  for (let index = entry.queue.length - 1; index >= 0; index -= 1) {
    const contextKey = entry.queue[index].contextKey ?? null;
    if (contextKey !== null) {
      entry.lastContextKey = contextKey;
      return;
    }
  }
  entry.lastContextKey = null;
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
  resetQueueState(key, entry);
  recordConsumedDeliveryQueueIds(key, removed);
  return removed;
}

export function consumeSelectedSystemEventEntries(
  sessionKey: string,
  consumedEntries: readonly SystemEvent[],
): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = getSessionQueue(key);
  if (!entry || entry.queue.length === 0 || consumedEntries.length === 0) {
    return [];
  }
  const removed: SystemEvent[] = [];
  for (const consumed of consumedEntries) {
    const index = entry.queue.findIndex((event) => areSystemEventsEqual(event, consumed));
    if (index === -1) {
      continue;
    }
    const [event] = entry.queue.splice(index, 1);
    if (event) {
      removed.push(cloneSystemEvent(event));
    }
  }
  resetQueueState(key, entry);
  recordConsumedDeliveryQueueIds(key, removed);
  return removed;
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

/** Queue ids whose events crossed into an attached session prompt. */
export function peekConsumedSystemEventDeliveryQueueIds(sessionKey: string): string[] {
  return [...(consumedDeliveryQueueIds.get(requireSessionKey(sessionKey)) ?? [])];
}

/** Forget queue ids only after their attached-session agent run succeeds. */
export function forgetConsumedSystemEventDeliveryQueueIds(
  sessionKey: string,
  acknowledgedIds: readonly string[],
): void {
  const key = requireSessionKey(sessionKey);
  const pending = consumedDeliveryQueueIds.get(key);
  if (!pending) {
    return;
  }
  for (const id of acknowledgedIds) {
    pending.delete(id);
  }
  if (pending.size === 0) {
    consumedDeliveryQueueIds.delete(key);
  }
}

/** Release in-flight queue ids after an attached-session run fails before acknowledgement. */
export function releaseConsumedSystemEventDeliveryQueueIds(sessionKey: string): void {
  consumedDeliveryQueueIds.delete(requireSessionKey(sessionKey));
}

export function resetSystemEventsForTest() {
  queues.clear();
  consumedDeliveryQueueIds.clear();
}
