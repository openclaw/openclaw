import { expectDefined } from "@openclaw/normalization-core";
// Lightweight in-memory queue for human-readable system events that should be
// prefixed to the next prompt. We intentionally avoid persistence to keep
// events ephemeral. Events are session-scoped and require an explicit key.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { DelegatedToolParameterPolicy } from "../agents/inherited-tool-parameters.types.js";
import { assertInheritedToolPolicyCompatible } from "../agents/inherited-tool-policy.js";
import type { InheritedToolPolicyV2 } from "../agents/inherited-tool-policy.schema.js";
import { channelRouteDedupeKey } from "../plugin-sdk/channel-route.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolveGlobalMap, resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { generateSecureUuid } from "./secure-random.js";
import {
  getSystemEventStorePath,
  isSystemEventStoreCurrent,
  registerSystemEventStoreOwner,
  recordSystemEventStoreReplaced,
} from "./system-event-ownership.js";

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
  sessionStorePath?: string | null;
};

const MAX_EVENTS = 20;

type SessionQueue = {
  queue: SystemEvent[];
  lastContextKey: string | null;
};

const SYSTEM_EVENT_QUEUES_KEY = Symbol.for("openclaw.systemEvents.queues");

const delegatedPolicies = resolveGlobalSingleton<WeakMap<SystemEvent, InheritedToolPolicyV2>>(
  Symbol.for("openclaw.systemEvents.delegatedPolicies"),
  () => new WeakMap(),
);

const queues = resolveGlobalMap<string, SessionQueue>(SYSTEM_EVENT_QUEUES_KEY, "close-only");
registerSystemEventStoreOwner(SYSTEM_EVENT_QUEUES_KEY, () => {
  for (const [key, entry] of queues) {
    const retained = entry.queue.filter((event) =>
      isSystemEventStoreCurrent(key, event.sessionStorePath),
    );
    if (retained.length === entry.queue.length) {
      continue;
    }
    entry.queue = retained;
    resetQueueState(key, entry);
    recordSystemEventStoreReplaced();
  }
});

type SystemEventOptions = {
  sessionKey: string;
  sessionStorePath?: string | null;
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
  const cloned = {
    ...event,
    ...(event.deliveryContext ? { deliveryContext: { ...event.deliveryContext } } : {}),
  };
  const policy = delegatedPolicies.get(event);
  if (policy) {
    delegatedPolicies.set(cloned, policy);
  }
  return cloned;
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
  delegatedPolicy?: InheritedToolPolicyV2,
): SystemEvent | null {
  const key = requireSessionKey(options.sessionKey);
  const sessionStorePath =
    options.sessionStorePath === undefined
      ? getSystemEventStorePath(key)
      : options.sessionStorePath;
  if (!isSystemEventStoreCurrent(key, sessionStorePath)) {
    recordSystemEventStoreReplaced();
    return null;
  }
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
    ...(sessionStorePath === undefined ? {} : { sessionStorePath }),
    contextKey: normalizedContextKey,
    deliveryContext: normalizedDeliveryContext,
  };
  if (delegatedPolicy) {
    delegatedPolicies.set(event, delegatedPolicy);
  }
  entry.queue.push(event);
  if (entry.queue.length > MAX_EVENTS) {
    entry.queue.shift();
  }
  return event;
}

/** A delegated notification is only disclosed after the receiving tools are prepared. */
export function enqueueDelegatedSystemEventEntry(
  text: string,
  options: SystemEventOptions,
  policy: InheritedToolPolicyV2,
): SystemEvent | null {
  const event = enqueueOwnedSystemEventEntry(text, options, undefined, policy);
  return event ? cloneSystemEvent(event) : null;
}

/** Incompatible events stay pending without restricting the ordinary receiving turn. */
export function consumeDelegatedSystemEventEntries(
  sessionKey: string,
  target: InheritedToolPolicyV2,
  accept: (policies: readonly InheritedToolPolicyV2[]) => boolean,
  targetEnforcedParameters?: DelegatedToolParameterPolicy,
): { events: SystemEvent[]; policies: InheritedToolPolicyV2[]; deferred: number } {
  const candidates = getSessionQueue(sessionKey)?.queue ?? [];
  const compatible: SystemEvent[] = [];
  let deferred = 0;
  for (const event of candidates) {
    const source = delegatedPolicies.get(event);
    if (!source) {
      continue;
    }
    if (deferred > 0) {
      deferred += 1;
      continue;
    }
    try {
      assertInheritedToolPolicyCompatible({ source, target, targetEnforcedParameters });
      compatible.push(event);
    } catch {
      deferred += 1;
    }
  }
  const policies = compatible.flatMap((event) => delegatedPolicies.get(event) ?? []);
  if (policies.length > 0 && !accept(policies)) {
    return { events: [], policies: [], deferred: deferred + compatible.length };
  }
  const events = consumeSelectedSystemEventEntries(sessionKey, compatible);
  return {
    events,
    policies: events.flatMap((event) => delegatedPolicies.get(event) ?? []),
    deferred,
  };
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
  const event = enqueueOwnedSystemEventEntry(text, options, receiptOptions);
  if (!event) {
    return null;
  }
  const sessionKey = requireSessionKey(options.sessionKey);
  return () => consumeSelectedSystemEventEntries(sessionKey, [event]).length > 0;
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
  const selected = entry.queue.filter((event) => !delegatedPolicies.has(event));
  const out = selected.map(project);
  entry.queue = entry.queue.filter((event) => delegatedPolicies.has(event));
  resetQueueState(key, entry);
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
  return removed;
}

export function drainSystemEvents(sessionKey: string): string[] {
  return drainSystemEventsWith(sessionKey, (event) => event.text);
}

export function peekSystemEventEntries(sessionKey: string): SystemEvent[] {
  return (
    getSessionQueue(sessionKey)
      ?.queue.filter((event) => !delegatedPolicies.has(event))
      .map(cloneSystemEvent) ?? []
  );
}

export function peekSystemEvents(sessionKey: string): string[] {
  return (
    getSessionQueue(sessionKey)
      ?.queue.filter((event) => !delegatedPolicies.has(event))
      .map((event) => event.text) ?? []
  );
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
}
