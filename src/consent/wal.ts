/**
 * Write-ahead log for ConsentGate decisions.
 * Append-only; one event per decision. Rotation/compaction can be added later.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { WalEvent, WalEventType } from "./types.js";

export type WalWriter = {
  append(event: Omit<WalEvent, "eventId" | "ts">): void;
};

export type AuditForwardingOptions = {
  destination: string;
  redactSecrets?: boolean;
};

function redactEvent(event: WalEvent, redact: boolean): WalEvent {
  if (!redact) return event;
  return {
    ...event,
    jti: event.jti != null ? "[redacted]" : null,
    actor: {},
  };
}

/**
 * Wraps a WAL and forwards each event to an audit destination (stdout or file path).
 * Used when gateway.consentGate.audit.enabled is true for SIEM/compliance.
 */
export function createAuditForwardingWal(
  inner: WalWriter,
  options: AuditForwardingOptions,
): WalWriter {
  const dest = options.destination.trim().toLowerCase();
  const isStdout = dest === "stdout";
  const write = isStdout
    ? (line: string) => {
        process.stdout.write(line + "\n");
      }
    : (() => {
        const path = options.destination.trim();
        const stream = fs.createWriteStream(path, { flags: "a" });
        return (line: string) => {
          stream.write(line + "\n");
        };
      })();

  return {
    append(partial) {
      const event: WalEvent = {
        eventId: randomUUID(),
        ts: Date.now(),
        ...partial,
      };
      inner.append(partial);
      const out = redactEvent(event, options.redactSecrets ?? true);
      try {
        write(JSON.stringify(out));
      } catch {
        // Do not block or throw on audit write failure
      }
    },
  };
}

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
