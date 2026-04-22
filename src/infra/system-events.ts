// In-memory queue with disk persistence for system events.
// When the main session context is busy, events are backed to disk so they
// can be recovered after a gateway restart.

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
import { createSubsystemLogger } from "../logging/subsystem.js";
import path from "node:path";
import fs from "node:fs/promises";

const log = createSubsystemLogger("system-events");

export type SystemEvent = {
  text: string;
  ts: number;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
  trusted?: boolean;
};

const MAX_EVENTS = 20;

// Disk persistence path — set by callers via setPendingEventsPath()
let _pendingEventsPath: string | null = null;

export function setPendingEventsPath(p: string) {
  _pendingEventsPath = p;
}

function pendingEventsPath(): string | null {
  if (_pendingEventsPath) return _pendingEventsPath;
  // Fallback: OPENCLAW_DATA_DIR env or ~/.openclaw
  return (
    process.env["OPENCLAW_DATA_DIR"] ||
    (process.env["HOME"]
      ? path.join(process.env["HOME"], ".openclaw", "pending_system_events.jsonl")
      : null)
  );
}

type SessionQueue = {
  queue: SystemEvent[];
  lastText: string | null;
  lastContextKey: string | null;
};

const SYSTEM_EVENT_QUEUES_KEY = Symbol.for("openclaw.systemEvents.queues");

const queues = resolveGlobalMap<string, SessionQueue>(SYSTEM_EVENT_QUEUES_KEY);

type SystemEventOptions = {
  sessionKey: string;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
  trusted?: boolean;
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
  };
  queues.set(key, created);
  // Synchronously recover any pending events for this session from disk
  _loadDiskQueue(key, created).catch(() => {});
  return created;
}

async function _loadDiskQueue(key: string, created: SessionQueue): Promise<void> {
  const p = pendingEventsPath();
  if (!p) return;
  try {
    const data = await fs.readFile(p, "utf-8");
    const lines = data.trim().split("\n").filter(Boolean);
    const toKeep: string[] = [];
    let restored = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as {
          sessionKey: string;
          event: SystemEvent;
          phase: string;
        };
        if (entry.sessionKey === key && entry.phase === "pending") {
          // Restore into in-memory queue
          created.queue.push(entry.event);
          created.lastText = entry.event.text;
          created.lastContextKey = entry.event.contextKey ?? null;
          restored++;
        } else {
          toKeep.push(line);
        }
      } catch {
        toKeep.push(line);
      }
    }
    if (restored > 0) {
      log.info(`Restored ${restored} pending events from disk for session ${key}`);
    }
    // Write back entries that don't belong to this session
    if (toKeep.length > 0) {
      await fs.writeFile(p, toKeep.join("\n") + "\n", "utf-8");
    } else {
      await fs.unlink(p).catch(() => {});
    }
  } catch {
    // No disk backup yet — that's fine
  }
}

async function _cleanupOldEntries(): Promise<void> {
  const p = pendingEventsPath();
  if (!p) return;
  try {
    const data = await fs.readFile(p, "utf-8").catch(() => "");
    if (!data.trim()) return;
    const lines = data.trim().split("\n").filter(Boolean);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24 hours
    const remaining = lines.filter((line) => {
      try {
        const e = JSON.parse(line) as { ts: number };
        return e.ts >= cutoff;
      } catch {
        return false;
      }
    });
    const removed = lines.length - remaining.length;
    if (removed > 0) {
      log.info(`Cleaned up ${removed} stale disk-persistence entries older than 24h`);
      if (remaining.length > 0) {
        await fs.writeFile(p, remaining.join("\n") + "\n", "utf-8");
      } else {
        await fs.unlink(p).catch(() => {});
      }
    }
  } catch {
    // Best-effort cleanup
  }
}

let _cleanupCounter = 0;

async function _appendDiskEntry(sessionKey: string, event: SystemEvent): Promise<void> {
  const p = pendingEventsPath();
  if (!p) return;
  const line = JSON.stringify({ sessionKey, event, phase: "pending", ts: Date.now() });
  try {
    await fs.appendFile(p, line + "\n", "utf-8");
    // Periodically clean up entries older than 24h
    _cleanupCounter++;
    if (_cleanupCounter % 10 === 0) {
      _cleanupOldEntries().catch(() => {});
    }
  } catch {
    // Best-effort disk write
  }
}

async function _writeAllPendingForKey(
  key: string,
  queueSlice: SystemEvent[],
): Promise<void> {
  const p = pendingEventsPath();
  if (!p) return;
  try {
    if (queueSlice.length === 0) {
      // Remove this session's pending entries from disk
      const data = await fs.readFile(p, "utf-8").catch(() => "");
      const lines = data.trim().split("\n").filter(Boolean);
      const remaining = lines.filter((line) => {
        try {
          const e = JSON.parse(line) as { sessionKey: string; phase: string };
          return !(e.sessionKey === key && e.phase === "pending");
        } catch {
          return true;
        }
      });
      if (remaining.length > 0) {
        await fs.writeFile(p, remaining.join("\n") + "\n", "utf-8");
      } else {
        await fs.unlink(p).catch(() => {});
      }
    } else {
      // Keep only this session's pending events on disk
      const newLines = queueSlice.map((ev) =>
        JSON.stringify({ sessionKey: key, event: ev, phase: "pending", ts: Date.now() }),
      );
      await fs.writeFile(p, newLines.join("\n") + "\n", "utf-8");
      log.info(`Persisted ${queueSlice.length} pending events to disk for session ${key}`);
    }
  } catch {
    // Best-effort disk write
  }
}

function cloneSystemEvent(event: SystemEvent): SystemEvent {
  return {
    ...event,
    ...(event.deliveryContext
      ? { deliveryContext: { ...event.deliveryContext } }
      : {}),
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
  entry.lastContextKey = normalizedContextKey;
  if (entry.lastText === cleaned) {
    return false;
  } // skip consecutive duplicates
  entry.lastText = cleaned;
  const newEvent: SystemEvent = {
    text: cleaned,
    ts: Date.now(),
    contextKey: normalizedContextKey,
    deliveryContext: normalizedDeliveryContext,
    trusted: options.trusted !== false,
  };
  entry.queue.push(newEvent);
  if (entry.queue.length > MAX_EVENTS) {
    entry.queue.shift();
  }
  // Async disk backup — survives gateway restart
  _appendDiskEntry(key, newEvent).catch(() => {});
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
  queues.delete(key);
  _writeAllPendingForKey(key, []).catch(() => {});
  return out;
}

function areDeliveryContextsEqual(
  left?: DeliveryContext,
  right?: DeliveryContext,
): boolean {
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
    (left.trusted ?? true) === (right.trusted ?? true) &&
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
    !consumedEntries.every((event, index) =>
      areSystemEventsEqual(entry.queue[index], event),
    )
  ) {
    return [];
  }
  // Before consuming, persist any remaining (unconsumed) events to disk
  if (entry.queue.length > consumedEntries.length) {
    const remaining = entry.queue.slice(consumedEntries.length);
    entry.queue.length = consumedEntries.length;
    entry.lastText = consumedEntries[consumedEntries.length - 1]?.text ?? null;
    entry.lastContextKey = consumedEntries[consumedEntries.length - 1]?.contextKey ?? null;
    _writeAllPendingForKey(key, remaining).catch(() => {});
    return consumedEntries.map(cloneSystemEvent);
  }
  const removed = entry.queue.splice(0, consumedEntries.length).map(cloneSystemEvent);
  entry.lastText = null;
  entry.lastContextKey = null;
  queues.delete(key);
  _writeAllPendingForKey(key, []).catch(() => {});
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
