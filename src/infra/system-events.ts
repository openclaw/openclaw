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
    return false;
  }
  const normalizedContextKey = normalizeContextKey(options?.contextKey);
  entry.lastContextKey = normalizedContextKey;
  if (entry.lastText === cleaned) {
    return false;
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

function isSameSystemEventEntry(a: SystemEvent, b: SystemEvent): boolean {
  return a.text === b.text && a.ts === b.ts && (a.contextKey ?? null) === (b.contextKey ?? null);
}

/**
 * Consume a previously peeked snapshot from the head of the session queue while
 * preserving any events that arrived after the snapshot was taken.
 */
export function consumeSystemEventSnapshot(
  sessionKey: string,
  snapshot: SystemEvent[],
): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = queues.get(key);
  if (!entry || entry.queue.length === 0 || snapshot.length === 0) {
    return [];
  }

  const consumed: SystemEvent[] = [];
  for (const expected of snapshot) {
    const head = entry.queue[0];
    if (!head || !isSameSystemEventEntry(head, expected)) {
      break;
    }
    const shifted = entry.queue.shift();
    if (shifted) {
      consumed.push(shifted);
    }
  }

  if (entry.queue.length === 0) {
    entry.lastText = null;
    entry.lastContextKey = null;
    queues.delete(key);
  }

  return consumed;
}

/**
 * Restore a previously peeked snapshot at the head of the session queue while
 * preserving any newer events that arrived after the snapshot was drained.
 */
export function restoreSystemEventSnapshot(
  sessionKey: string,
  snapshot: SystemEvent[],
): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  if (snapshot.length === 0) {
    return [];
  }

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

  let alreadyRestored = snapshot.length <= entry.queue.length;
  if (alreadyRestored) {
    for (let index = 0; index < snapshot.length; index += 1) {
      if (!isSameSystemEventEntry(entry.queue[index], snapshot[index])) {
        alreadyRestored = false;
        break;
      }
    }
  }
  if (alreadyRestored) {
    return [];
  }

  entry.queue = [...snapshot, ...entry.queue];
  if (entry.queue.length > MAX_EVENTS) {
    entry.queue.length = MAX_EVENTS;
  }
  const last = entry.queue.at(-1) ?? null;
  entry.lastText = last?.text ?? null;
  entry.lastContextKey = last?.contextKey ?? null;
  return snapshot.map((event) => ({ ...event }));
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

export function resetSystemEventsForTest() {
  queues.clear();
}
