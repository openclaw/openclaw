// Lightweight in-memory queue for human-readable system events that should be
// prefixed to the next prompt. We intentionally avoid persistence to keep
// events ephemeral. Events are session-scoped and require an explicit key.

export type SystemEvent = { text: string; ts: number; contextKey?: string | null };

const MAX_EVENTS = 20;

type SessionQueue = {
  queue: SystemEvent[];
  lastText: string | null;
  lastContextKey: string | null;
  dedupeKeys: Map<string, number>;
};

const queues = new Map<string, SessionQueue>();

type SystemEventOptions = {
  sessionKey: string;
  contextKey?: string | null;
  dedupeKey?: string | null;
  dedupeTtlMs?: number;
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

function normalizeDedupeKey(key?: string | null): string | null {
  if (!key) {
    return null;
  }
  const trimmed = key.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.toLowerCase();
}

function normalizeDedupeTtlMs(value?: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function pruneExpiredDedupeKeys(entry: SessionQueue, now: number) {
  for (const [key, expiresAt] of entry.dedupeKeys.entries()) {
    if (expiresAt <= now) {
      entry.dedupeKeys.delete(key);
    }
  }
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
        dedupeKeys: new Map<string, number>(),
      };
      queues.set(key, created);
      return created;
    })();
  const cleaned = text.trim();
  if (!cleaned) {
    return false;
  }
  const now = Date.now();
  pruneExpiredDedupeKeys(entry, now);

  const normalizedDedupeKey = normalizeDedupeKey(options?.dedupeKey);
  const dedupeTtlMs = normalizeDedupeTtlMs(options?.dedupeTtlMs);
  if (normalizedDedupeKey && dedupeTtlMs > 0) {
    const existingExpiry = entry.dedupeKeys.get(normalizedDedupeKey) ?? 0;
    if (existingExpiry > now) {
      return false;
    }
  }

  const normalizedContextKey = normalizeContextKey(options?.contextKey);
  const hasExplicitDedupeWindow = Boolean(normalizedDedupeKey && dedupeTtlMs > 0);
  if (!hasExplicitDedupeWindow && entry.lastText === cleaned) {
    return false;
  } // skip consecutive duplicates unless a dedupe-key window governs replay
  entry.lastText = cleaned;
  entry.lastContextKey = normalizedContextKey;
  if (normalizedDedupeKey && dedupeTtlMs > 0) {
    entry.dedupeKeys.set(normalizedDedupeKey, now + dedupeTtlMs);
  }
  entry.queue.push({
    text: cleaned,
    ts: now,
    contextKey: normalizedContextKey,
  });
  if (entry.queue.length > MAX_EVENTS) {
    entry.queue.shift();
  }
  return true;
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

export function hasSystemEvents(sessionKey: string) {
  const key = requireSessionKey(sessionKey);
  return (queues.get(key)?.queue.length ?? 0) > 0;
}

export function clearSystemEventDedupeKey(sessionKey: string, dedupeKey?: string | null) {
  const key = requireSessionKey(sessionKey);
  const normalized = normalizeDedupeKey(dedupeKey);
  if (!normalized) {
    return false;
  }
  const entry = queues.get(key);
  if (!entry) {
    return false;
  }
  return entry.dedupeKeys.delete(normalized);
}

export function resetSystemEventsForTest() {
  queues.clear();
}
