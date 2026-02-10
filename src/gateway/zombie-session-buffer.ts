/**
 * Zombie session buffer for WebSocket recovery persistence.
 * Keeps session handles alive during transient disconnects (e.g. 1006).
 * Allows re-binding when a new connection arrives for the same agent:channel:recipient triplet.
 */

const ZOMBIE_REAPER_MS = 30_000;

export type ZombieSessionEntry = {
  sessionKey: string;
  disconnectedAt: number;
  reaperTimer: ReturnType<typeof setTimeout>;
};

export type QueuedPayload<T> = {
  payload: T;
  queuedAt: number;
};

export type ZombieBufferCallbacks<T> = {
  onReap: (sessionKey: string) => void;
  onReBind?: (sessionKey: string) => void;
};

const zombieSessions = new Map<string, ZombieSessionEntry>();
const queuedPayloads = new Map<string, QueuedPayload<unknown>[]>();
let callbacks: ZombieBufferCallbacks<unknown> | null = null;

function scheduleReaper(sessionKey: string): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    const entry = zombieSessions.get(sessionKey);
    if (!entry) {
      return;
    }
    zombieSessions.delete(sessionKey);
    queuedPayloads.delete(sessionKey);
    callbacks?.onReap(sessionKey);
  }, ZOMBIE_REAPER_MS);
}

/**
 * Mark a session as zombie on disconnect. Starts the 30s reaper.
 */
export function markZombie(sessionKey: string): void {
  const key = sessionKey.trim();
  if (!key) {
    return;
  }
  const existing = zombieSessions.get(key);
  if (existing) {
    clearTimeout(existing.reaperTimer);
  }
  zombieSessions.set(key, {
    sessionKey: key,
    disconnectedAt: Date.now(),
    reaperTimer: scheduleReaper(key),
  });
}

/**
 * Check if a session is zombie.
 */
export function isZombie(sessionKey: string): boolean {
  return zombieSessions.has(sessionKey.trim());
}

/**
 * Re-bind a new connection to an existing zombie session.
 * Halts the reaper and returns queued payloads to flush.
 */
export function reBind<T = unknown>(sessionKey: string): QueuedPayload<T>[] {
  const key = sessionKey.trim();
  if (!key) {
    return [];
  }
  const entry = zombieSessions.get(key);
  if (!entry) {
    return [];
  }
  clearTimeout(entry.reaperTimer);
  zombieSessions.delete(key);
  const queued = (queuedPayloads.get(key) ?? []) as QueuedPayload<T>[];
  queuedPayloads.delete(key);
  callbacks?.onReBind?.(key);
  return queued;
}

/**
 * Queue a payload for a zombie session.
 */
export function queuePayload<T>(sessionKey: string, payload: T): void {
  const key = sessionKey.trim();
  if (!key) {
    return;
  }
  if (!zombieSessions.has(key)) {
    return;
  }
  const list = queuedPayloads.get(key) ?? [];
  list.push({ payload, queuedAt: Date.now() });
  queuedPayloads.set(key, list);
}

/**
 * Get number of queued payloads for a session.
 */
export function getQueuedCount(sessionKey: string): number {
  return (queuedPayloads.get(sessionKey.trim()) ?? []).length;
}

/**
 * Set callbacks (e.g. for logging).
 */
export function setZombieBufferCallbacks<T>(cb: ZombieBufferCallbacks<T> | null): void {
  callbacks = cb as ZombieBufferCallbacks<unknown> | null;
}

/**
 * Clear all zombie state (e.g. on gateway shutdown).
 */
export function clearZombieBuffer(): void {
  for (const entry of zombieSessions.values()) {
    clearTimeout(entry.reaperTimer);
  }
  zombieSessions.clear();
  queuedPayloads.clear();
}
