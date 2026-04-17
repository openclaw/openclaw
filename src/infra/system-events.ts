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
import { recordReceipt } from "./outbound/delivery-receipts.js";
import type { MessageClass } from "./outbound/message-class.js";

export type SystemEvent = {
  text: string;
  ts: number;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
  // legacy: derive-on-read when messageClass is the authoritative field
  trusted?: boolean;
  // Phase 1 of the Discord Surface Overhaul: classification is the
  // authoritative signal. `trusted` remains for backwards compatibility.
  messageClass?: MessageClass;
};

const MAX_EVENTS = 20;

type SessionQueue = {
  queue: SystemEvent[];
  lastText: string | null;
  lastContextKey: string | null;
  lastMessageClass: MessageClass | null;
};

const SYSTEM_EVENT_QUEUES_KEY = Symbol.for("openclaw.systemEvents.queues");

const queues = resolveGlobalMap<string, SessionQueue>(SYSTEM_EVENT_QUEUES_KEY);

type SystemEventOptions = {
  sessionKey: string;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
  trusted?: boolean;
  messageClass?: MessageClass;
};

// Resolve the effective message class given an explicit value (preferred) and
// the legacy `trusted` boolean. When both are absent, default to
// "internal_narration" so new callers cannot accidentally surface progress as
// user-facing final replies.
function resolveMessageClass(
  messageClass: MessageClass | undefined,
  trusted: boolean,
): MessageClass {
  if (messageClass) {
    return messageClass;
  }
  return trusted ? "final_reply" : "internal_narration";
}

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
    lastMessageClass: null,
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
  // Phase 1 fix: default `trusted` to false, not true. Legacy callers that
  // omitted the flag previously defaulted to trusted=true, which the new
  // classification layer would treat as final_reply — silently promoting
  // arbitrary events onto user-facing surfaces. The explicit comparison
  // `=== true` keeps only callers who opt in explicitly.
  const trusted = options.trusted === true;
  const normalizedMessageClass = resolveMessageClass(options.messageClass, trusted);
  entry.lastContextKey = normalizedContextKey;
  // Dedup is now keyed by (text, messageClass) so a re-classification of an
  // identical message still delivers a distinct queue entry.
  if (entry.lastText === cleaned && entry.lastMessageClass === normalizedMessageClass) {
    return false;
  } // skip consecutive duplicates with the same classification
  entry.lastText = cleaned;
  entry.lastMessageClass = normalizedMessageClass;
  entry.queue.push({
    text: cleaned,
    ts: Date.now(),
    contextKey: normalizedContextKey,
    deliveryContext: normalizedDeliveryContext,
    trusted,
    messageClass: normalizedMessageClass,
  });
  if (entry.queue.length > MAX_EVENTS) {
    entry.queue.shift();
  }
  // Phase 9 Discord Surface Overhaul: record a delivery receipt for the
  // queued path. `messageId` is unknown at enqueue time (set when the
  // delivery worker actually sends), so we intentionally omit it here.
  // We do NOT re-record for the acp-spawn-parent-stream caller because that
  // caller records before/after planDelivery with a richer reason tag. To
  // avoid double-counting, guard on a well-known contextKey shape.
  const isAcpSpawnParentStream =
    typeof normalizedContextKey === "string" && normalizedContextKey.startsWith("acp-spawn:");
  if (!isAcpSpawnParentStream) {
    const ctx = normalizedDeliveryContext;
    recordReceipt(key, {
      target:
        ctx?.channel && ctx?.to
          ? {
              channel: ctx.channel,
              to: ctx.to,
              ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
              ...(ctx.threadId != null ? { threadId: ctx.threadId } : {}),
            }
          : { channel: "unknown", to: "unknown" },
      messageClass: normalizedMessageClass,
      outcome: "delivered",
      reason: "enqueue_system_event",
      ts: Date.now(),
      resolvedContextAt: Date.now(),
    });
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
  entry.lastMessageClass = null;
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
    // Phase 1 Discord Surface Overhaul: legacy `trusted` now defaults to
    // false, matching the new enqueue-time default. Events that predate this
    // change may lack the property; treat missing as false.
    (left.trusted ?? false) === (right.trusted ?? false) &&
    (left.messageClass ?? null) === (right.messageClass ?? null) &&
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
    entry.lastMessageClass = null;
    queues.delete(key);
  } else {
    const newest = entry.queue[entry.queue.length - 1];
    entry.lastText = newest.text;
    entry.lastContextKey = newest.contextKey ?? null;
    entry.lastMessageClass = newest.messageClass ?? null;
  }
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

export function resetSystemEventsForTest() {
  queues.clear();
}
