/**
 * Security Events System - Phase 6 Security Monitoring & Detection
 *
 * Core event system with emit, subscribe, persist, query, and dedup.
 * JSONL persistence with bounded size/retention + in-memory ring buffer.
 */

import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";

const log = createSubsystemLogger("security/events");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type SecurityEventSeverity = "info" | "warn" | "critical";

export type SecurityEventType =
  // Audit/scan events (Plan 1)
  | "skill_scan_failed"
  | "container_escape_attempt"
  | "credential_audit_integrity_failed"
  | "credential_rotation_due"
  | "injection_detected"
  | "security_audit_critical"
  | "security_audit_warning"
  | "env_credential_exposed"
  | "monitor_failure"
  // Runtime events (P2)
  | "credential_access_spike"
  | "auth_rate_limited"
  | "tool_abuse_detected"
  | "session_anomaly";

export interface SecurityEvent {
  /** Unique event ID */
  id: string;
  /** Timestamp (ms since epoch) */
  ts: number;
  /** Event type */
  type: SecurityEventType;
  /** Severity level */
  severity: SecurityEventSeverity;
  /** Source module/component */
  source: string;
  /** Human-readable message */
  message: string;
  /** Sanitized details (size-capped) */
  details: Record<string, unknown>;
  /** Remediation guidance */
  remediation?: string;
  /** Fingerprint for dedup */
  fingerprint: string;
  /** Dedup occurrence count */
  occurrences: number;
  /** First occurrence timestamp */
  firstOccurrence: number;
  /** Session key context */
  sessionKey?: string;
  /** Agent ID context */
  agentId?: string;
  /** Correlation ID for forensics */
  correlationId?: string;
}

export interface SecurityEventEmitParams {
  type: SecurityEventType;
  severity: SecurityEventSeverity;
  source: string;
  message: string;
  details?: Record<string, unknown>;
  remediation?: string;
  sessionKey?: string;
  agentId?: string;
  correlationId?: string;
  /** Custom fingerprint; if not provided, auto-generated from type+source+message */
  fingerprint?: string;
}

export interface SecurityEventsConfig {
  /** Path to JSONL event store */
  store?: string;
  /** Max file size in bytes before rotation (default: 2MB) */
  maxBytes?: number;
  /** Max lines to keep after rotation (default: 2000) */
  keepLines?: number;
  /** In-memory ring buffer size (default: 500) */
  inMemoryLimit?: number;
}

export interface AlertingConfig {
  /** Minimum severity to alert on (default: "critical") */
  minSeverity?: SecurityEventSeverity;
  /** Dedup window in ms (default: 15 minutes) */
  dedupeWindow?: number;
  /** Webhook config */
  webhook?: {
    enabled?: boolean;
    url?: string;
    token?: string;
    timeoutMs?: number;
  };
}

export interface SecurityEventQueryFilters {
  type?: SecurityEventType | SecurityEventType[];
  severity?: SecurityEventSeverity | SecurityEventSeverity[];
  source?: string;
  since?: number;
  until?: number;
  sessionKey?: string;
  agentId?: string;
  limit?: number;
  offset?: number;
}

export type SecurityEventListener = (event: SecurityEvent) => void | Promise<void>;

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_STORE_PATH = "~/.openclaw/security-events.jsonl";
const DEFAULT_MAX_BYTES = 2_000_000; // 2MB
const DEFAULT_KEEP_LINES = 2_000;
const DEFAULT_IN_MEMORY_LIMIT = 500;
const DEFAULT_DEDUPE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_DETAILS_SIZE = 10_000; // chars
const MAX_ROTATED_FILES = 3;

const SEVERITY_ORDER: Record<SecurityEventSeverity, number> = {
  info: 0,
  warn: 1,
  critical: 2,
};

// -----------------------------------------------------------------------------
// Ring Buffer
// -----------------------------------------------------------------------------

class RingBuffer<T> {
  private buffer: T[] = [];
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  push(item: T): void {
    this.buffer.push(item);
    while (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  getAll(): T[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer = [];
  }

  size(): number {
    return this.buffer.length;
  }
}

// -----------------------------------------------------------------------------
// Security Events Manager
// -----------------------------------------------------------------------------

export class SecurityEventsManager {
  private config: Required<SecurityEventsConfig>;
  private alertingConfig: Required<AlertingConfig>;
  private ringBuffer: RingBuffer<SecurityEvent>;
  private dedupeMap = new Map<string, { event: SecurityEvent; expiry: number }>();
  private emitter = new EventEmitter();
  private initialized = false;

  constructor(config?: SecurityEventsConfig, alerting?: AlertingConfig) {
    this.config = {
      store: config?.store ?? DEFAULT_STORE_PATH,
      maxBytes: config?.maxBytes ?? DEFAULT_MAX_BYTES,
      keepLines: config?.keepLines ?? DEFAULT_KEEP_LINES,
      inMemoryLimit: config?.inMemoryLimit ?? DEFAULT_IN_MEMORY_LIMIT,
    };
    this.alertingConfig = {
      minSeverity: alerting?.minSeverity ?? "critical",
      dedupeWindow: alerting?.dedupeWindow ?? DEFAULT_DEDUPE_WINDOW_MS,
      webhook: {
        enabled: alerting?.webhook?.enabled ?? false,
        url: alerting?.webhook?.url ?? "",
        token: alerting?.webhook?.token ?? "",
        timeoutMs: alerting?.webhook?.timeoutMs ?? 5000,
      },
    };
    this.ringBuffer = new RingBuffer(this.config.inMemoryLimit);
  }

  /**
   * Initialize the events manager (load recent events into memory).
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const storePath = this.resolveStorePath();
    if (fs.existsSync(storePath)) {
      const events = this.readEventsFromFile(storePath, this.config.inMemoryLimit);
      for (const event of events) {
        this.ringBuffer.push(event);
      }
      log.debug("loaded events into ring buffer", { count: events.length });
    }

    this.initialized = true;
    log.info("security events manager initialized", {
      storePath,
      inMemoryCount: this.ringBuffer.size(),
    });
  }

  /**
   * Emit a security event.
   */
  emit(params: SecurityEventEmitParams): SecurityEvent {
    const now = Date.now();

    // Generate fingerprint
    const fingerprint =
      params.fingerprint ?? this.computeFingerprint(params.type, params.source, params.message);

    // Check dedup
    const dedupEntry = this.dedupeMap.get(fingerprint);
    if (dedupEntry && dedupEntry.expiry > now) {
      // Deduplicate: increment occurrences, don't persist
      dedupEntry.event.occurrences += 1;
      log.debug("deduplicated event", {
        fingerprint: fingerprint.slice(0, 8),
        occurrences: dedupEntry.event.occurrences,
      });
      return dedupEntry.event;
    }

    // Sanitize details
    const sanitizedDetails = this.sanitizeDetails(params.details ?? {});

    // Create event
    const event: SecurityEvent = {
      id: randomUUID(),
      ts: now,
      type: params.type,
      severity: params.severity,
      source: params.source,
      message: params.message,
      details: sanitizedDetails,
      remediation: params.remediation,
      fingerprint,
      occurrences: 1,
      firstOccurrence: now,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      correlationId: params.correlationId,
    };

    // Add to ring buffer
    this.ringBuffer.push(event);

    // Update dedup map
    this.dedupeMap.set(fingerprint, {
      event,
      expiry: now + this.alertingConfig.dedupeWindow,
    });

    // Persist to file
    this.persistEvent(event);

    // Emit to listeners
    this.emitter.emit("event", event);

    // Check for alert
    if (this.shouldAlert(event)) {
      this.triggerAlert(event);
    }

    log.debug("emitted security event", {
      id: event.id,
      type: event.type,
      severity: event.severity,
      fingerprint: fingerprint.slice(0, 8),
    });

    return event;
  }

  /**
   * Subscribe to security events.
   */
  subscribe(listener: SecurityEventListener): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  /**
   * Subscribe to alert-level events only.
   */
  subscribeAlerts(listener: SecurityEventListener): () => void {
    const wrapper = (event: SecurityEvent) => {
      if (this.shouldAlert(event)) {
        void listener(event);
      }
    };
    this.emitter.on("event", wrapper);
    return () => this.emitter.off("event", wrapper);
  }

  /**
   * Query events with filters.
   */
  query(filters?: SecurityEventQueryFilters): SecurityEvent[] {
    // Start with in-memory events
    let events = this.ringBuffer.getAll();

    // If we need more or have time-based filters, read from file
    const needFileRead =
      (filters?.limit && filters.limit > events.length) ||
      (filters?.since && events.length > 0 && events[0].ts > filters.since);

    if (needFileRead) {
      const storePath = this.resolveStorePath();
      if (fs.existsSync(storePath)) {
        const fileEvents = this.readEventsFromFile(storePath);
        // Merge and dedupe by ID
        const seen = new Set(events.map((e) => e.id));
        for (const event of fileEvents) {
          if (!seen.has(event.id)) {
            events.unshift(event);
            seen.add(event.id);
          }
        }
      }
    }

    // Apply filters
    if (filters) {
      if (filters.type) {
        const types = Array.isArray(filters.type) ? filters.type : [filters.type];
        events = events.filter((e) => types.includes(e.type));
      }
      if (filters.severity) {
        const severities = Array.isArray(filters.severity) ? filters.severity : [filters.severity];
        events = events.filter((e) => severities.includes(e.severity));
      }
      if (filters.source) {
        events = events.filter((e) => e.source === filters.source);
      }
      if (filters.since) {
        events = events.filter((e) => e.ts >= filters.since!);
      }
      if (filters.until) {
        events = events.filter((e) => e.ts <= filters.until!);
      }
      if (filters.sessionKey) {
        events = events.filter((e) => e.sessionKey === filters.sessionKey);
      }
      if (filters.agentId) {
        events = events.filter((e) => e.agentId === filters.agentId);
      }
      if (filters.offset) {
        events = events.slice(filters.offset);
      }
      if (filters.limit) {
        events = events.slice(0, filters.limit);
      }
    }

    return events;
  }

  /**
   * Get recent events from ring buffer.
   */
  getRecent(limit?: number): SecurityEvent[] {
    const events = this.ringBuffer.getAll();
    if (limit && events.length > limit) {
      return events.slice(-limit);
    }
    return events;
  }

  /**
   * Get event counts by severity.
   */
  getStats(since?: number): {
    total: number;
    bySeverity: Record<SecurityEventSeverity, number>;
    byType: Partial<Record<SecurityEventType, number>>;
  } {
    const events = since ? this.query({ since }) : this.ringBuffer.getAll();

    const bySeverity: Record<SecurityEventSeverity, number> = {
      info: 0,
      warn: 0,
      critical: 0,
    };

    const byType: Partial<Record<SecurityEventType, number>> = {};

    for (const event of events) {
      bySeverity[event.severity]++;
      byType[event.type] = (byType[event.type] ?? 0) + 1;
    }

    return {
      total: events.length,
      bySeverity,
      byType,
    };
  }

  /**
   * Clear the dedup map (for testing or manual reset).
   */
  clearDedup(): void {
    this.dedupeMap.clear();
  }

  /**
   * Clean up expired dedup entries.
   */
  pruneDedup(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [fingerprint, entry] of this.dedupeMap) {
      if (entry.expiry <= now) {
        this.dedupeMap.delete(fingerprint);
        pruned++;
      }
    }
    return pruned;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private resolveStorePath(): string {
    return resolveUserPath(this.config.store);
  }

  private computeFingerprint(type: string, source: string, message: string): string {
    const data = `${type}:${source}:${message}`;
    return createHash("sha256").update(data).digest("hex").slice(0, 16);
  }

  private sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
    const json = JSON.stringify(details);
    if (json.length <= MAX_DETAILS_SIZE) {
      return details;
    }

    // Truncate to fit
    const truncated: Record<string, unknown> = {};
    let size = 2; // "{}"
    for (const [key, value] of Object.entries(details)) {
      const entry = JSON.stringify({ [key]: value });
      if (size + entry.length - 2 > MAX_DETAILS_SIZE) {
        truncated["_truncated"] = true;
        break;
      }
      truncated[key] = value;
      size += entry.length - 2 + 1; // -2 for braces, +1 for comma
    }
    return truncated;
  }

  private persistEvent(event: SecurityEvent): void {
    try {
      const storePath = this.resolveStorePath();
      const dir = path.dirname(storePath);

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      // Check if rotation needed
      if (fs.existsSync(storePath)) {
        const stat = fs.statSync(storePath);
        if (stat.size >= this.config.maxBytes) {
          this.rotateFile(storePath);
        }
      }

      const line = JSON.stringify(event) + "\n";
      fs.appendFileSync(storePath, line, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      log.warn("failed to persist security event", {
        error: error instanceof Error ? error.message : String(error),
        eventId: event.id,
      });
    }
  }

  private rotateFile(storePath: string): void {
    try {
      const dir = path.dirname(storePath);
      const base = path.basename(storePath, ".jsonl");

      // Rotate existing files
      for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
        const from = path.join(dir, `${base}.${i}.jsonl`);
        const to = path.join(dir, `${base}.${i + 1}.jsonl`);
        if (fs.existsSync(from)) {
          if (i === MAX_ROTATED_FILES - 1) {
            fs.unlinkSync(from);
          } else {
            fs.renameSync(from, to);
          }
        }
      }

      // Keep only recent lines
      const content = fs.readFileSync(storePath, "utf8");
      const lines = content.split("\n").filter((l) => l.trim());
      const keptLines = lines.slice(-this.config.keepLines);

      // Write kept lines to rotated file
      const rotatedPath = path.join(dir, `${base}.1.jsonl`);
      fs.writeFileSync(rotatedPath, keptLines.join("\n") + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });

      // Truncate main file
      fs.writeFileSync(storePath, "", { encoding: "utf8", mode: 0o600 });

      log.info("rotated security events file", {
        keptLines: keptLines.length,
        rotatedPath,
      });
    } catch (error) {
      log.warn("failed to rotate security events file", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private readEventsFromFile(filePath: string, limit?: number): SecurityEvent[] {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n").filter((l) => l.trim());
      let events: SecurityEvent[] = [];

      for (const line of lines) {
        try {
          events.push(JSON.parse(line) as SecurityEvent);
        } catch {
          // Skip malformed lines
        }
      }

      if (limit && events.length > limit) {
        events = events.slice(-limit);
      }

      return events;
    } catch {
      return [];
    }
  }

  private shouldAlert(event: SecurityEvent): boolean {
    const minSeverityOrder = SEVERITY_ORDER[this.alertingConfig.minSeverity];
    const eventSeverityOrder = SEVERITY_ORDER[event.severity];
    return eventSeverityOrder >= minSeverityOrder;
  }

  private triggerAlert(event: SecurityEvent): void {
    // Emit alert event
    this.emitter.emit("alert", event);

    // Log at appropriate level
    const logMethod = event.severity === "critical" ? "error" : "warn";
    log[logMethod]("SECURITY ALERT", {
      type: event.type,
      severity: event.severity,
      message: event.message,
      source: event.source,
    });

    // Send webhook if configured
    if (this.alertingConfig.webhook.enabled && this.alertingConfig.webhook.url) {
      this.sendWebhook(event).catch((error) => {
        log.warn("failed to send security alert webhook", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private async sendWebhook(event: SecurityEvent): Promise<void> {
    const { url, token, timeoutMs } = this.alertingConfig.webhook;

    if (!url) {
      log.warn("webhook URL not configured, skipping alert");
      return;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          event,
          timestamp: new Date().toISOString(),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Webhook returned ${response.status}`);
      }

      log.debug("sent security alert webhook", { eventId: event.id });
    } finally {
      clearTimeout(timeout);
    }
  }
}

// -----------------------------------------------------------------------------
// Singleton Instance
// -----------------------------------------------------------------------------

let defaultManager: SecurityEventsManager | undefined;

/**
 * Get or create the default SecurityEventsManager instance.
 */
export function getSecurityEventsManager(
  config?: SecurityEventsConfig,
  alerting?: AlertingConfig,
): SecurityEventsManager {
  if (!defaultManager) {
    defaultManager = new SecurityEventsManager(config, alerting);
  }
  return defaultManager;
}

/**
 * Reset the default manager (for testing).
 */
export function resetSecurityEventsManager(): void {
  defaultManager = undefined;
}

// -----------------------------------------------------------------------------
// Convenience Exports
// -----------------------------------------------------------------------------

/**
 * Emit a security event using the default manager.
 */
export function emitSecurityEvent(params: SecurityEventEmitParams): SecurityEvent {
  return getSecurityEventsManager().emit(params);
}

/**
 * Query security events using the default manager.
 */
export function querySecurityEvents(filters?: SecurityEventQueryFilters): SecurityEvent[] {
  return getSecurityEventsManager().query(filters);
}

/**
 * Subscribe to security events using the default manager.
 */
export function subscribeSecurityEvents(listener: SecurityEventListener): () => void {
  return getSecurityEventsManager().subscribe(listener);
}

/**
 * Subscribe to alert-level events using the default manager.
 */
export function subscribeSecurityAlerts(listener: SecurityEventListener): () => void {
  return getSecurityEventsManager().subscribeAlerts(listener);
}
