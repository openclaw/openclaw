// Lightweight in-memory queue for human-readable system events that should be
// prefixed to the next prompt. We intentionally avoid persistence to keep
// events ephemeral. Events are session-scoped and require an explicit key.

export type SystemEvent = { text: string; ts: number; contextKey?: string | null };

const MAX_EVENTS = 20;

type SessionQueue = {
  queue: SystemEvent[];
  lastText: string | null;
  lastContextKey: string | null;
};

const queues = new Map<string, SessionQueue>();

type SystemEventOptions = {
  sessionKey: string;
  contextKey?: string | null;
};

function requireSessionKey(key?: string | null): string {
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (!trimmed) {
    throw new Error("system events require a sessionKey");
  }
  return trimmed;
}

function normalizeContextKey(key?: string | null): string | null {
  if (!key) {
    return null;
  }
  const trimmed = key.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.toLowerCase();
}

export function isSystemEventContextChanged(
  sessionKey: string,
  contextKey?: string | null,
): boolean {
  const key = requireSessionKey(sessionKey);
  const existing = queues.get(key);
  const normalized = normalizeContextKey(contextKey);
  return normalized !== (existing?.lastContextKey ?? null);
}

export function enqueueSystemEvent(text: string, options: SystemEventOptions) {
  const key = requireSessionKey(options?.sessionKey);
  const entry =
    queues.get(key) ??
    (() => {
      const created: SessionQueue = {
        queue: [],
        lastText: null,
        lastContextKey: null,
      };
      queues.set(key, created);
      return created;
    })();
  const cleaned = text.trim();
  if (!cleaned) {
    return;
  }
  const normalizedContextKey = normalizeContextKey(options?.contextKey);
  entry.lastContextKey = normalizedContextKey;
  if (entry.lastText === cleaned) {
    return;
  } // skip consecutive duplicates
  entry.lastText = cleaned;
  entry.queue.push({
    text: cleaned,
    ts: Date.now(),
    contextKey: normalizedContextKey,
  });
  if (entry.queue.length > MAX_EVENTS) {
    entry.queue.shift();
  }
}

export function drainSystemEventEntries(sessionKey: string): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = queues.get(key);
  if (!entry || entry.queue.length === 0) {
    return [];
  }
  const out = entry.queue.slice();
  entry.queue.length = 0;
  entry.lastText = null;
  entry.lastContextKey = null;
  queues.delete(key);
  return out;
}

export function drainSystemEvents(sessionKey: string): string[] {
  return drainSystemEventEntries(sessionKey).map((event) => event.text);
}

export function peekSystemEventEntries(sessionKey: string): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  return queues.get(key)?.queue.map((event) => ({ ...event })) ?? [];
}

export function peekSystemEvents(sessionKey: string): string[] {
  return peekSystemEventEntries(sessionKey).map((event) => event.text);
}

/**
 * Remove all queued events whose `contextKey` matches `key` (case-insensitive)
 * across ALL session queues.
 * Used to drop pending notifications for deleted cron jobs (#18880).
 */
export function dropSystemEventsByContextKey(contextKey: string): number {
  const normalized = contextKey.trim().toLowerCase();
  if (!normalized) {
    return 0;
  }
  let total = 0;
  for (const [sessionKey, entry] of queues) {
    const before = entry.queue.length;
    entry.queue = entry.queue.filter((e) => e.contextKey !== normalized);
    total += before - entry.queue.length;
    if (entry.queue.length === 0) {
      queues.delete(sessionKey);
    }
  }
  return total;
}

export function hasSystemEvents(sessionKey: string) {
  const key = requireSessionKey(sessionKey);
  return (queues.get(key)?.queue.length ?? 0) > 0;
}

export function resetSystemEventsForTest() {
  queues.clear();
}
