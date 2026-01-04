// Lightweight in-memory queue for human-readable system events that should be
// prefixed to the next prompt. We intentionally avoid persistence to keep
// events ephemeral. Events are session-scoped; callers that don't specify a
// session key default to "main".

type SystemEvent = { text: string; ts: number };

const DEFAULT_SESSION_KEY = "main";
const MAX_EVENTS = 20;

type SessionQueue = {
  queue: SystemEvent[];
  lastText: string | null;
  lastContextKey: string | null;
};

const queues = new Map<string, SessionQueue>();

type SystemEventOptions = {
  contextKey?: string | null;
  sessionKey?: string | null;
};

function normalizeSessionKey(key?: string | null): string {
  const trimmed = typeof key === "string" ? key.trim() : "";
  return trimmed || DEFAULT_SESSION_KEY;
}

function normalizeContextKey(key?: string | null): string | null {
  if (!key) return null;
  const trimmed = key.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

export function isSystemEventContextChanged(
  contextKey?: string | null,
  sessionKey?: string | null,
): boolean {
  const key = normalizeSessionKey(sessionKey);
  const existing = queues.get(key);
  const normalized = normalizeContextKey(contextKey);
  return normalized !== (existing?.lastContextKey ?? null);
}

export function enqueueSystemEvent(text: string, options?: SystemEventOptions) {
  const key = normalizeSessionKey(options?.sessionKey);
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
  if (!cleaned) return;
  entry.lastContextKey = normalizeContextKey(options?.contextKey);
  if (entry.lastText === cleaned) return; // skip consecutive duplicates
  entry.lastText = cleaned;
  entry.queue.push({ text: cleaned, ts: Date.now() });
  if (entry.queue.length > MAX_EVENTS) entry.queue.shift();
}

export function drainSystemEvents(sessionKey?: string | null): string[] {
  const key = normalizeSessionKey(sessionKey);
  const entry = queues.get(key);
  if (!entry || entry.queue.length === 0) return [];
  const out = entry.queue.map((e) => e.text);
  entry.queue.length = 0;
  entry.lastText = null;
  entry.lastContextKey = null;
  queues.delete(key);
  return out;
}

export function peekSystemEvents(sessionKey?: string | null): string[] {
  const key = normalizeSessionKey(sessionKey);
  return queues.get(key)?.queue.map((e) => e.text) ?? [];
}

export function hasSystemEvents(sessionKey?: string | null) {
  const key = normalizeSessionKey(sessionKey);
  return (queues.get(key)?.queue.length ?? 0) > 0;
}

export function resetSystemEventsForTest() {
  queues.clear();
}
