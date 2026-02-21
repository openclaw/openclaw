/**
 * Safety Event Log
 *
 * Provides a ring buffer for safety events with optional JSONL file persistence.
 * Shared dependency for all safety modules.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SafetyEventCategory =
  | "injection"
  | "secret-leak"
  | "alignment-violation"
  | "approval-required"
  | "rate-limit"
  | "kill-switch"
  | "tool-block"
  | "output-filter";

export type SafetyEventSeverity = "info" | "warn" | "critical";

export type SafetyEvent = {
  ts: number;
  category: SafetyEventCategory;
  severity: SafetyEventSeverity;
  message: string;
  sessionKey?: string;
  agentId?: string;
  toolName?: string;
  metadata?: Record<string, unknown>;
};

export type SafetyEventQuery = {
  category?: SafetyEventCategory;
  severity?: SafetyEventSeverity;
  since?: number;
  limit?: number;
  sessionKey?: string;
};

export type SafetyEventStats = {
  total: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
  oldestTs: number | null;
  newestTs: number | null;
};

const DEFAULT_BUFFER_SIZE = 10_000;
const DEFAULT_LOG_DIR = path.join(os.homedir(), ".openclaw");
const DEFAULT_LOG_FILE = "safety-events.jsonl";

export class SafetyEventLog {
  private buffer: SafetyEvent[] = [];
  private bufferSize: number;
  private writeIndex = 0;
  private count = 0;
  private logFilePath: string | null = null;
  private fileStream: fs.WriteStream | null = null;

  constructor(opts?: { bufferSize?: number; logFile?: string | boolean }) {
    this.bufferSize = opts?.bufferSize ?? DEFAULT_BUFFER_SIZE;
    this.buffer = Array.from<SafetyEvent>({ length: this.bufferSize });

    if (opts?.logFile === true) {
      this.logFilePath = path.join(DEFAULT_LOG_DIR, DEFAULT_LOG_FILE);
    } else if (typeof opts?.logFile === "string") {
      this.logFilePath = opts.logFile;
    }

    if (this.logFilePath) {
      try {
        const dir = path.dirname(this.logFilePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        this.fileStream = fs.createWriteStream(this.logFilePath, { flags: "a" });
      } catch {
        // If we can't open the log file, continue with in-memory only
        this.logFilePath = null;
      }
    }
  }

  emit(event: Omit<SafetyEvent, "ts"> & { ts?: number }): SafetyEvent {
    const fullEvent: SafetyEvent = {
      ts: event.ts ?? Date.now(),
      category: event.category,
      severity: event.severity,
      message: event.message,
      ...(event.sessionKey ? { sessionKey: event.sessionKey } : {}),
      ...(event.agentId ? { agentId: event.agentId } : {}),
      ...(event.toolName ? { toolName: event.toolName } : {}),
      ...(event.metadata ? { metadata: event.metadata } : {}),
    };

    this.buffer[this.writeIndex] = fullEvent;
    this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
    if (this.count < this.bufferSize) {
      this.count += 1;
    }

    if (this.fileStream) {
      try {
        this.fileStream.write(JSON.stringify(fullEvent) + "\n");
      } catch {
        // Silently ignore write errors
      }
    }

    return fullEvent;
  }

  query(filters?: SafetyEventQuery): SafetyEvent[] {
    const events = this.getOrderedEvents();
    let filtered = events;

    if (filters?.category) {
      filtered = filtered.filter((e) => e.category === filters.category);
    }
    if (filters?.severity) {
      filtered = filtered.filter((e) => e.severity === filters.severity);
    }
    if (filters?.since) {
      filtered = filtered.filter((e) => e.ts >= filters.since!);
    }
    if (filters?.sessionKey) {
      filtered = filtered.filter((e) => e.sessionKey === filters.sessionKey);
    }
    if (filters?.limit && filters.limit > 0) {
      filtered = filtered.slice(-filters.limit);
    }

    return filtered;
  }

  getStats(since?: number): SafetyEventStats {
    const events = since
      ? this.getOrderedEvents().filter((e) => e.ts >= since)
      : this.getOrderedEvents();

    const byCategory: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    let oldestTs: number | null = null;
    let newestTs: number | null = null;

    for (const event of events) {
      byCategory[event.category] = (byCategory[event.category] ?? 0) + 1;
      bySeverity[event.severity] = (bySeverity[event.severity] ?? 0) + 1;
      if (oldestTs === null || event.ts < oldestTs) {
        oldestTs = event.ts;
      }
      if (newestTs === null || event.ts > newestTs) {
        newestTs = event.ts;
      }
    }

    return {
      total: events.length,
      byCategory,
      bySeverity,
      oldestTs,
      newestTs,
    };
  }

  clear(): void {
    this.buffer = Array.from<SafetyEvent>({ length: this.bufferSize });
    this.writeIndex = 0;
    this.count = 0;
  }

  close(): void {
    if (this.fileStream) {
      this.fileStream.end();
      this.fileStream = null;
    }
  }

  private getOrderedEvents(): SafetyEvent[] {
    if (this.count === 0) {
      return [];
    }
    if (this.count < this.bufferSize) {
      return this.buffer.slice(0, this.count);
    }
    // Ring buffer is full, reorder from oldest to newest
    return [...this.buffer.slice(this.writeIndex), ...this.buffer.slice(0, this.writeIndex)];
  }
}

// Singleton instance for global use
let globalEventLog: SafetyEventLog | null = null;

export function getGlobalEventLog(): SafetyEventLog {
  if (!globalEventLog) {
    globalEventLog = new SafetyEventLog();
  }
  return globalEventLog;
}

export function initGlobalEventLog(opts?: {
  bufferSize?: number;
  logFile?: string | boolean;
}): SafetyEventLog {
  if (globalEventLog) {
    globalEventLog.close();
  }
  globalEventLog = new SafetyEventLog(opts);
  return globalEventLog;
}
