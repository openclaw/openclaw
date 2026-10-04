// Lightweight in-memory queue for human-readable system events that should be
// prefixed to the next prompt. We intentionally avoid persistence to keep
// events ephemeral. Events are session-scoped and require an explicit key.

import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
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

type PreparedAutomationNotice = {
  assertCurrent: () => void;
  release: () => void;
};
type AutomationNoticeOwner = {
  jobId: string;
  assertCurrent: () => void;
  prepare?: () => Promise<PreparedAutomationNotice>;
};

const turnOwners = resolveGlobalSingleton(
  Symbol.for("openclaw.systemEvents.turnOwners"),
  () =>
    new WeakMap<
      SystemEvent,
      {
        cancel: () => void;
        started: boolean;
        automation?: AutomationNoticeOwner;
      }
    >(),
);
function clearSystemEventQueues(value: Map<string, SessionQueue>) {
  const removed = [...value.values()].flatMap((entry) => entry.queue.splice(0));
  value.clear();
  for (const event of removed) {
    retireSystemEvent(event);
  }
}
const queues = resolveGlobalMap<string, SessionQueue>(
  SYSTEM_EVENT_QUEUES_KEY,
  clearSystemEventQueues,
  "close-and-restart",
);
registerSystemEventStoreOwner(SYSTEM_EVENT_QUEUES_KEY, () => {
  for (const [key, entry] of queues) {
    const removed = entry.queue.filter(
      (event) => !isSystemEventStoreCurrent(key, event.sessionStorePath),
    );
    const retained = entry.queue.filter((event) =>
      isSystemEventStoreCurrent(key, event.sessionStorePath),
    );
    if (retained.length === entry.queue.length) {
      continue;
    }
    entry.queue = retained;
    resetQueueState(key, entry);
    for (const event of removed) {
      retireSystemEvent(event);
    }
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
  return {
    ...event,
    ...(event.deliveryContext ? { deliveryContext: { ...event.deliveryContext } } : {}),
  };
}

function retireSystemEvent(event: SystemEvent): void {
  const owner = turnOwners.get(event);
  if (owner && !owner.started) {
    owner.cancel();
  }
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
  receiptOptions?: ReceiptOptions,
): SystemEvent | null {
  const event = enqueueOwnedSystemEventEntry(text, options, receiptOptions);
  return event ? cloneSystemEvent(event) : null;
}

function enqueueOwnedSystemEventEntry(
  text: string,
  options: SystemEventOptions,
  receiptOptions?: ReceiptOptions,
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
    for (const event of matching) {
      retireSystemEvent(event);
    }
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
  entry.queue.push(event);
  if (entry.queue.length > MAX_EVENTS) {
    const evicted = entry.queue.shift();
    if (evicted) {
      retireSystemEvent(evicted);
    }
  }
  return event;
}

export function enqueueSystemEvent(text: string, options: SystemEventOptions) {
  return enqueueOwnedSystemEventEntry(text, options) !== null;
}

/** Transfer one exact occurrence to ordinary session admission. */
export function claimSystemEventTurn(
  sessionKey: string,
  occurrence: SystemEvent,
  cancel: () => void,
  agentId?: string,
) {
  const key = requireSessionKey(sessionKey);
  if (agentId && parseAgentSessionKey(key)?.agentId !== agentId) {
    return undefined;
  }
  const event = getSessionQueue(key)?.queue.find((entry) => entry.id === occurrence.id);
  if (!event || turnOwners.has(event)) {
    return undefined;
  }
  const owner = { cancel, started: false };
  turnOwners.set(event, owner);
  return {
    start() {
      if (owner.started || !getSessionQueue(key)?.queue.includes(event)) {
        throw new Error("Session event occurrence was cancelled before admission");
      }
      owner.started = true;
      consumeSelectedSystemEventEntries(key, [event]);
    },
    cancel: () => consumeSelectedSystemEventEntries(key, [event]).length > 0,
  };
}

export function isSystemEventTurnOwned(sessionKey: string, occurrence: SystemEvent): boolean {
  const event = getSessionQueue(sessionKey)?.queue.find((entry) => entry.id === occurrence.id);
  return event !== undefined && turnOwners.has(event);
}

/** Legacy deferred wakes attach notices to one ordinary job, never a later user message. */
export function enqueueAutomationSystemEvent(
  text: string,
  options: SystemEventOptions,
  automation: AutomationNoticeOwner,
): void {
  const event = enqueueOwnedSystemEventEntry(text, options, { allowDuplicate: true });
  if (!event) {
    throw new Error("Deferred automation event was not accepted");
  }
  turnOwners.set(event, { cancel: () => {}, started: false, automation });
}

export async function prepareAutomationSystemEvents(sessionKey: string, jobId: string) {
  let selected =
    getSessionQueue(sessionKey)?.queue.filter(
      (event) => turnOwners.get(event)?.automation?.jobId === jobId,
    ) ?? [];
  const leases: PreparedAutomationNotice[] = [];
  const release = () => {
    for (const lease of leases.splice(0)) {
      lease.release();
    }
  };
  const assertCurrent = () => {
    for (const lease of leases) {
      lease.assertCurrent();
    }
    for (const event of selected) {
      if (!getSessionQueue(sessionKey)?.queue.includes(event)) {
        throw new Error("Deferred automation notice was cancelled before execution");
      }
      turnOwners.get(event)!.automation!.assertCurrent();
    }
  };
  try {
    for (const event of selected) {
      let lease: PreparedAutomationNotice | undefined;
      try {
        lease = await turnOwners.get(event)?.automation?.prepare?.();
      } catch (error) {
        const { isSessionDeliveryGenerationRevokedError } =
          await import("../config/sessions/session-delivery-generation.js");
        if (!isSessionDeliveryGenerationRevokedError(error)) {
          throw error;
        }
        // A reset retires only this occurrence; storage unavailability stays retryable.
        consumeSelectedSystemEventEntries(sessionKey, [event]);
        selected = selected.filter((candidate) => candidate !== event);
        continue;
      }
      if (lease) {
        leases.push(lease);
      }
      assertCurrent();
    }
    assertCurrent();
  } catch (error) {
    release();
    throw error;
  }
  return {
    events: selected.map(cloneSystemEvent),
    assertCurrent,
    release,
    start() {
      assertCurrent();
      for (const event of selected) {
        turnOwners.get(event)!.started = true;
      }
      consumeSelectedSystemEventEntries(sessionKey, selected);
      release();
    },
  };
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
  const removed = entry.queue.splice(0);
  entry.lastContextKey = null;
  queues.delete(key);
  for (const event of removed) {
    retireSystemEvent(event);
  }
  return removed.map(project);
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

function matchesConsumedSystemEvent(queued: SystemEvent, consumed: SystemEvent): boolean {
  if (consumed.id !== undefined) {
    // Queue-owned IDs govern modern consumption; only legacy ID-less snapshots use structure.
    return queued.id === consumed.id;
  }
  return (
    queued.text === consumed.text &&
    queued.ts === consumed.ts &&
    (queued.contextKey ?? null) === (consumed.contextKey ?? null) &&
    areDeliveryContextsEqual(queued.deliveryContext, consumed.deliveryContext)
  );
}

function resetQueueState(key: string, entry: SessionQueue) {
  if (entry.queue.length === 0) {
    entry.lastContextKey = null;
    queues.delete(key);
    return;
  }
  entry.lastContextKey =
    entry.queue.findLast((event) => event.contextKey != null)?.contextKey ?? null;
}

export function consumeSelectedSystemEventEntries(
  sessionKey: string,
  consumedEntries: readonly SystemEvent[],
  options?: { deferredEventIds?: readonly string[] },
): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = queues.get(key);
  if (!entry || entry.queue.length === 0 || consumedEntries.length === 0) {
    return [];
  }
  // Prompt admission can defer captured occurrences to a delivery owner. Selection
  // still resolves against the live queue, in captured order, never late arrivals.
  const deferredIds = new Set(options?.deferredEventIds);
  const selected: SystemEvent[] = [];
  for (const consumed of consumedEntries) {
    const index = entry.queue.findIndex((event) => matchesConsumedSystemEvent(event, consumed));
    if (index === -1) {
      continue;
    }
    const event = entry.queue[index];
    if (event) {
      if (!event.id || !deferredIds.has(event.id)) {
        entry.queue.splice(index, 1);
        retireSystemEvent(event);
      }
      selected.push(cloneSystemEvent(event));
    }
  }
  resetQueueState(key, entry);
  return selected;
}

export function drainSystemEvents(sessionKey: string): string[] {
  return drainSystemEventsWith(sessionKey, (event) => event.text);
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
  clearSystemEventQueues(queues);
}
