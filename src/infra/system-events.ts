// Lightweight in-memory queue for human-readable system events that should be
// prefixed to the next prompt. We intentionally avoid persistence to keep
// events ephemeral. Events are session-scoped and require an explicit key.

import { channelRouteDedupeKey } from "../plugin-sdk/channel-route.js";
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

export type SystemEventAudience = "internal" | "user-facing";

export type SystemEvent = {
  text: string;
  ts: number;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
  trusted?: boolean;
  /**
   * Where this event is intended to surface in the agent transcript /
   * channel path.
   *
   *  - `"user-facing"` (default): event text is drained on the regular
   *    reply turn and emitted into the next prompt as a plain
   *    `System: ...` line. Visible in the agent transcript and channel
   *    surfaces.
   *  - `"internal"`: event text is still drained on the regular reply
   *    turn, but the consumer at `drainFormattedSystemEvents` wraps it in
   *    `INTERNAL_RUNTIME_CONTEXT_BEGIN`/`END` delimiters with the same
   *    canonical header lines as `formatAgentInternalEventsForPrompt` in
   *    `src/agents/internal-events.ts`. The model still sees the content
   *    as runtime context, but every user-facing surface strips it via
   *    the existing `stripInternalRuntimeContext` consumers
   *    (`sanitize-user-facing-text.ts`, `memory-host-sdk/host/session-files.ts`,
   *    `agents/internal-events.ts`, etc.).
   *
   * **Scope (important):**
   *  - This field is the *hidden runtime context* lane only. It is not a
   *    delivery-routing primitive: events that have a positive user
   *    delivery contract (exec completion via `notifyOnExit`, cron
   *    payloads, heartbeat acks) MUST NOT be migrated to `"internal"` —
   *    those have their own heartbeat-driven delivery paths
   *    (`buildExecEventPrompt` / `buildCronEventPrompt`) plus tactical
   *    producer-side skips (e.g. `bd60df3e53`). Marking them internal
   *    would suppress delivery on regular reply turns where the model is
   *    instructed to keep wrapped content private.
   *  - Operator-side inspection surfaces — `openclaw status`, log output,
   *    raw queue diagnostics — that read events via `peekSystemEvents`
   *    or `peekSystemEventEntries` continue to expose internal events
   *    for debugging. Callers that want audience-filtered views should
   *    iterate `peekSystemEventEntries` and branch on the field
   *    themselves.
   *
   * Independent of `trusted`. Adding `audience` does not change any
   * existing default behavior; callers that omit it keep emitting
   * `"user-facing"` events.
   */
  audience?: SystemEventAudience;
};

const MAX_EVENTS = 20;

type SessionQueue = {
  queue: SystemEvent[];
  lastText: string | null;
  lastContextKey: string | null;
  lastAudience: SystemEventAudience | null;
};

const SYSTEM_EVENT_QUEUES_KEY = Symbol.for("openclaw.systemEvents.queues");

const queues = resolveGlobalMap<string, SessionQueue>(SYSTEM_EVENT_QUEUES_KEY);

type SystemEventOptions = {
  sessionKey: string;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
  trusted?: boolean;
  audience?: SystemEventAudience;
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
    lastAudience: null,
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
  const audience: SystemEventAudience = options.audience ?? "user-facing";
  entry.lastContextKey = normalizedContextKey;
  // Consecutive-duplicate suppression keys on (text, audience) so two
  // back-to-back events with identical text but different audiences (e.g.
  // a user-facing emit followed by a hidden runtime-context emit of the
  // same line) do not collapse into one and silently drop the second
  // lane. Both must reach the queue or the wrap-on-drain contract breaks.
  if (entry.lastText === cleaned && entry.lastAudience === audience) {
    return false;
  }
  entry.lastText = cleaned;
  entry.lastAudience = audience;
  entry.queue.push({
    text: cleaned,
    ts: Date.now(),
    contextKey: normalizedContextKey,
    deliveryContext: normalizedDeliveryContext,
    trusted: options.trusted !== false,
    audience,
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
  entry.lastAudience = null;
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

function areSystemEventsEqual(left: SystemEvent, right: SystemEvent): boolean {
  return (
    left.text === right.text &&
    left.ts === right.ts &&
    (left.contextKey ?? null) === (right.contextKey ?? null) &&
    (left.trusted ?? true) === (right.trusted ?? true) &&
    (left.audience ?? "user-facing") === (right.audience ?? "user-facing") &&
    areDeliveryContextsEqual(left.deliveryContext, right.deliveryContext)
  );
}

function resetQueueState(key: string, entry: SessionQueue) {
  if (entry.queue.length === 0) {
    entry.lastText = null;
    entry.lastContextKey = null;
    entry.lastAudience = null;
    queues.delete(key);
    return;
  }
  const newest = entry.queue[entry.queue.length - 1];
  entry.lastText = newest.text;
  entry.lastContextKey = newest.contextKey ?? null;
  entry.lastAudience = newest.audience ?? "user-facing";
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
