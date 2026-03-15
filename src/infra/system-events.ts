// Lightweight in-memory queue for human-readable system events that should be
// prefixed to the next prompt. We intentionally avoid persistence to keep
// events ephemeral. Events are session-scoped and require an explicit key.

export type SystemEvent = {
  text: string;
  ts: number;
  contextKey?: string | null;
  order?: number;
};
export type SystemEventReservation = {
  sessionKey: string;
  reservationId: string;
  entries: SystemEvent[];
};
export type SystemEventSummaryReservation = {
  sessionKey: string;
  reservationId: string;
  lines: string[];
  generation: number;
};

const MAX_EVENTS = 20;
let nextReservationId = 0;
let nextEventOrder = 0;

type SessionQueue = {
  queue: SystemEvent[];
  reservations: Map<string, SystemEvent[]>;
  lastText: string | null;
  lastContextKey: string | null;
};

type SummaryState = {
  generation: number;
  lines: string[];
};

const queues = new Map<string, SessionQueue>();
const pendingSummaries = new Map<string, SummaryState>();
const summaryReservations = new Map<string, Map<string, SummaryState>>();
const consumedSummaryGenerations = new Map<string, number>();
let nextSummaryGeneration = 0;

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

function compareSystemEventOrder(left: SystemEvent, right: SystemEvent) {
  const leftOrder = left.order;
  const rightOrder = right.order;
  if (leftOrder !== undefined || rightOrder !== undefined) {
    return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
  }
  return left.ts - right.ts;
}

function enforceQueuedEventLimit(entry: SessionQueue) {
  entry.queue.sort(compareSystemEventOrder);
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
    order: nextEventOrder++,
  });
  enforceQueuedEventLimit(entry);
  return true;
}

function maybeDeleteSessionQueue(key: string, entry: SessionQueue) {
  if (entry.queue.length === 0 && entry.reservations.size === 0) {
    queues.delete(key);
  }
}

function getOrCreateSummaryReservationBucket(sessionKey: string) {
  const existing = summaryReservations.get(sessionKey);
  if (existing) {
    return existing;
  }
  const created = new Map<string, SummaryState>();
  summaryReservations.set(sessionKey, created);
  return created;
}

function maybeDeleteSummaryReservationBucket(
  sessionKey: string,
  bucket: Map<string, SummaryState>,
) {
  if (bucket.size === 0) {
    summaryReservations.delete(sessionKey);
  }
}

function createSummaryReservation(
  sessionKey: string,
  summary: SummaryState,
): SystemEventSummaryReservation | undefined {
  if (summary.lines.length === 0) {
    return undefined;
  }
  const stored: SummaryState = {
    generation: summary.generation,
    lines: summary.lines.slice(),
  };
  const reservationId = `s${nextReservationId++}`;
  const bucket = getOrCreateSummaryReservationBucket(sessionKey);
  bucket.set(reservationId, stored);
  return {
    sessionKey,
    reservationId,
    lines: stored.lines.slice(),
    generation: stored.generation,
  };
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

export function reserveSystemEventSummary(
  sessionKey: string,
): SystemEventSummaryReservation | undefined {
  const key = requireSessionKey(sessionKey);
  const summary = pendingSummaries.get(key);
  if (!summary || summary.lines.length === 0) {
    return undefined;
  }
  pendingSummaries.delete(key);
  return createSummaryReservation(key, summary);
}

export function createSystemEventSummaryReservation(
  sessionKey: string,
  lines: string[],
): SystemEventSummaryReservation | undefined {
  const key = requireSessionKey(sessionKey);
  const pending = pendingSummaries.get(key);
  if (pending) {
    return createSummaryReservation(key, pending);
  }
  const existing = summaryReservations.get(key)?.values().next().value;
  if (existing) {
    return createSummaryReservation(key, existing);
  }
  return createSummaryReservation(key, {
    generation: nextSummaryGeneration++,
    lines,
  });
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

export function commitSystemEventSummaryReservation(
  reservation: SystemEventSummaryReservation | undefined,
): string[] {
  if (!reservation) {
    return [];
  }
  const key = requireSessionKey(reservation.sessionKey);
  const bucket = summaryReservations.get(key);
  if (!bucket) {
    return [];
  }
  const lines = bucket.get(reservation.reservationId);
  if (!lines) {
    return [];
  }
  bucket.delete(reservation.reservationId);
  maybeDeleteSummaryReservationBucket(key, bucket);
  pendingSummaries.delete(key);
  consumedSummaryGenerations.set(key, lines.generation);
  return lines.lines.slice();
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
  entry.queue.push(...reserved);
  enforceQueuedEventLimit(entry);
  return reserved.map((event) => ({ ...event }));
}

export function restoreSystemEventSummaryReservation(
  reservation: SystemEventSummaryReservation | undefined,
): string[] {
  if (!reservation) {
    return [];
  }
  const key = requireSessionKey(reservation.sessionKey);
  const bucket = summaryReservations.get(key);
  if (!bucket) {
    return [];
  }
  const summary = bucket?.get(reservation.reservationId);
  if (!summary) {
    return [];
  }
  bucket.delete(reservation.reservationId);
  maybeDeleteSummaryReservationBucket(key, bucket);
  if (consumedSummaryGenerations.get(key) !== summary.generation) {
    pendingSummaries.set(key, {
      generation: summary.generation,
      lines: summary.lines.slice(),
    });
  }
  return summary.lines.slice();
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
      queued?.order !== target?.order ||
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
  pendingSummaries.clear();
  summaryReservations.clear();
  consumedSummaryGenerations.clear();
  nextReservationId = 0;
  nextSummaryGeneration = 0;
  nextEventOrder = 0;
}
