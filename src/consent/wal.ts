/**
 * Write-ahead log for ConsentGate decisions.
 * Append-only; one event per decision. Rotation/compaction can be added later.
 */

import { randomUUID } from "node:crypto";
import type { WalEvent, WalEventType } from "./types.js";

export type WalWriter = {
  append(event: Omit<WalEvent, "eventId" | "ts">): void;
};

/** In-memory WAL (for tests and default); can be replaced with file-backed. */
export function createInMemoryWal(): WalWriter & { getEvents(): WalEvent[] } {
  const events: WalEvent[] = [];
  return {
    append(partial) {
      events.push({
        eventId: randomUUID(),
        ts: Date.now(),
        ...partial,
      });
    },
    getEvents() {
      return [...events];
    },
  };
}

/** No-op WAL (observe-only or disabled). */
export function createNoOpWal(): WalWriter {
  return {
    append() {},
  };
}

export type { WalEvent, WalEventType };
