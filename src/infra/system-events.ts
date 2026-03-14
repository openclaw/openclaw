// Lightweight in-memory queue for human-readable system events that should be
// prefixed to the next prompt. We intentionally avoid persistence to keep
// events ephemeral. Events are session-scoped and require an explicit key.

export type SystemEvent = { text: string; ts: number; contextKey?: string | null };
export type SystemEventReservation = {
  sessionKey: string;
  reservationId: string;
  entries: SystemEvent[];
};

const MAX_EVENTS = 20;
let nextReservationId = 0;

type SessionQueue = {
  queue: SystemEvent[];
  reservations: Map<string, SystemEvent[]>;
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

function refreshQueueTailState(entry: SessionQueue) {
  const latest = entry.queue.at(-1);
  entry.lastText = latest?.text ?? null;
  entry.lastContextKey = latest?.contextKey ?? null;
}

function enforceQueuedEventLimit(entry: SessionQueue) {
  if (entry.queue.length > MAX_EVENTS) {
    entry.queue.splice(0, entry.queue.length - MAX_EVENTS);
  }
  refreshQueueTailState(entry);
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
        reservations: new Map(),
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
  enforceQueuedEventLimit(entry);
  return true;
}

function maybeDeleteSessionQueue(key: string, entry: SessionQueue) {
  if (entry.queue.length === 0 && entry.reservations.size === 0) {
    queues.delete(key);
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
  maybeDeleteSessionQueue(key, entry);
  return out;
}

export function reserveSystemEventEntries(sessionKey: string): SystemEventReservation | undefined {
  const key = requireSessionKey(sessionKey);
  const entry = queues.get(key);
  if (!entry || entry.queue.length === 0) {
    return undefined;
  }
  const reserved = entry.queue.slice();
  entry.queue.length = 0;
  entry.lastText = null;
  entry.lastContextKey = null;
  const reservationId = `r${nextReservationId++}`;
  entry.reservations.set(reservationId, reserved);
  return {
    sessionKey: key,
    reservationId,
    entries: reserved.map((event) => ({ ...event })),
  };
}

export function commitSystemEventReservation(
  reservation: SystemEventReservation | undefined,
): SystemEvent[] {
  if (!reservation) {
    return [];
  }
  const key = requireSessionKey(reservation.sessionKey);
  const entry = queues.get(key);
  if (!entry) {
    return [];
  }
  const reserved = entry.reservations.get(reservation.reservationId);
  if (!reserved) {
    return [];
  }
  entry.reservations.delete(reservation.reservationId);
  maybeDeleteSessionQueue(key, entry);
  return reserved.map((event) => ({ ...event }));
}

export function restoreSystemEventReservation(
  reservation: SystemEventReservation | undefined,
): SystemEvent[] {
  if (!reservation) {
    return [];
  }
  const key = requireSessionKey(reservation.sessionKey);
  const entry =
    queues.get(key) ??
    (() => {
      const created: SessionQueue = {
        queue: [],
        reservations: new Map(),
        lastText: null,
        lastContextKey: null,
      };
      queues.set(key, created);
      return created;
    })();
  const reserved = entry.reservations.get(reservation.reservationId);
  if (!reserved) {
    return [];
  }
  entry.reservations.delete(reservation.reservationId);
  entry.queue.unshift(...reserved);
  enforceQueuedEventLimit(entry);
  return reserved.map((event) => ({ ...event }));
}

export function consumeSystemEventEntries(
  sessionKey: string,
  expected: SystemEvent[],
): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = queues.get(key);
  if (!entry || expected.length === 0) {
    return [];
  }
  let count = 0;
  while (count < expected.length && count < entry.queue.length) {
    const queued = entry.queue[count];
    const target = expected[count];
    if (
      queued?.text !== target?.text ||
      queued?.ts !== target?.ts ||
      (queued?.contextKey ?? null) !== (target?.contextKey ?? null)
    ) {
      break;
    }
    count += 1;
  }
  if (count === 0) {
    return [];
  }
  const out = entry.queue.splice(0, count);
  refreshQueueTailState(entry);
  maybeDeleteSessionQueue(key, entry);
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

export function resetSystemEventsForTest() {
  queues.clear();
  nextReservationId = 0;
}
