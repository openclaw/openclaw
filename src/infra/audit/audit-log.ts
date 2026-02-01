/**
 * Audit log storage
 *
 * JSONL-based storage with monthly rotation and retention.
 */

import crypto from "node:crypto";
import { mkdir, readFile, writeFile, appendFile, readdir, stat, unlink } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { emitAuditEvent, onAuditEvent } from "./audit-events.js";
import type {
  AuditEvent,
  AuditCategory,
  AuditSeverity,
  AuditAction,
  AuditQueryParams,
  AuditQueryResult,
} from "./types.js";
import { AUDIT_LOG_RETENTION_DAYS, MAX_AUDIT_EVENTS_PER_QUERY } from "./types.js";

/** Directory for audit data */
const AUDIT_DIR = ".clawdbrain/audit";

/** Get the current month's log file name */
function getCurrentLogFileName(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `events-${year}-${month}.jsonl`;
}

/**
 * Resolve the audit directory path.
 */
export function resolveAuditDir(homeDir: string): string {
  return join(homeDir, AUDIT_DIR);
}

/**
 * Resolve the current audit log file path.
 */
export function resolveCurrentAuditLogPath(homeDir: string): string {
  return join(resolveAuditDir(homeDir), getCurrentLogFileName());
}

/**
 * Append an audit event to the log.
 */
export async function appendAuditEvent(homeDir: string, event: AuditEvent): Promise<void> {
  const logPath = resolveCurrentAuditLogPath(homeDir);
  await mkdir(dirname(logPath), { recursive: true });

  const line = JSON.stringify(event) + "\n";
  await appendFile(logPath, line, "utf-8");

  // Emit to listeners
  emitAuditEvent(event);
}

/**
 * Create and log an audit event.
 */
export async function logAuditEvent(
  homeDir: string,
  params: Omit<AuditEvent, "id" | "ts">,
): Promise<AuditEvent> {
  const event = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    ...params,
  } as AuditEvent;

  await appendAuditEvent(homeDir, event);
  return event;
}

/**
 * Query audit events with filters.
 */
export async function queryAuditEvents(
  homeDir: string,
  params: AuditQueryParams = {},
): Promise<AuditQueryResult> {
  const { category, action, severity, startTs, endTs, limit = 100, offset = 0 } = params;

  const auditDir = resolveAuditDir(homeDir);
  let allEvents: AuditEvent[] = [];

  try {
    const files = await readdir(auditDir);
    const logFiles = files.filter((f) => f.startsWith("events-") && f.endsWith(".jsonl"));

    // Sort by date descending (newest first)
    logFiles.sort().reverse();

    for (const file of logFiles) {
      const filePath = join(auditDir, file);
      const content = await readFile(filePath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      for (const line of lines) {
        try {
          const event = JSON.parse(line) as AuditEvent;
          allEvents.push(event);
        } catch {
          // Skip invalid lines
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("Failed to read audit log:", error);
    }
    return { events: [], total: 0, hasMore: false };
  }

  // Apply filters
  let filtered = allEvents;

  if (category) {
    filtered = filtered.filter((e) => e.category === category);
  }

  if (action) {
    filtered = filtered.filter((e) => e.action === action);
  }

  if (severity) {
    filtered = filtered.filter((e) => e.severity === severity);
  }

  if (startTs) {
    filtered = filtered.filter((e) => e.ts >= startTs);
  }

  if (endTs) {
    filtered = filtered.filter((e) => e.ts <= endTs);
  }

  // Sort by timestamp descending
  filtered.sort((a, b) => b.ts - a.ts);

  const total = filtered.length;
  const effectiveLimit = Math.min(limit, MAX_AUDIT_EVENTS_PER_QUERY);
  const events = filtered.slice(offset, offset + effectiveLimit);
  const hasMore = offset + effectiveLimit < total;

  return { events, total, hasMore };
}

/**
 * Clean up old audit log files based on retention policy.
 */
export async function cleanupOldAuditLogs(homeDir: string): Promise<number> {
  const auditDir = resolveAuditDir(homeDir);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - AUDIT_LOG_RETENTION_DAYS);

  let deletedCount = 0;

  try {
    const files = await readdir(auditDir);
    const logFiles = files.filter((f) => f.startsWith("events-") && f.endsWith(".jsonl"));

    for (const file of logFiles) {
      // Extract date from filename (events-YYYY-MM.jsonl)
      const match = file.match(/events-(\d{4})-(\d{2})\.jsonl/);
      if (!match) continue;

      const year = parseInt(match[1], 10);
      const month = parseInt(match[2], 10);
      const fileDate = new Date(year, month - 1, 1);

      if (fileDate < cutoffDate) {
        const filePath = join(auditDir, file);
        await unlink(filePath);
        deletedCount++;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("Failed to cleanup audit logs:", error);
    }
  }

  return deletedCount;
}

// =============================================================================
// Convenience functions for common audit events
// =============================================================================

export function createConfigAuditEvent(
  action: "config.get" | "config.patch" | "config.apply" | "config.set",
  detail: { path?: string; previousValue?: unknown; newValue?: unknown } = {},
  severity: AuditSeverity = "info",
): Omit<AuditEvent, "id" | "ts"> {
  return {
    category: "config",
    action,
    severity,
    detail,
  } as Omit<AuditEvent, "id" | "ts">;
}

export function createSecurityAuditEvent(
  action:
    | "unlock.attempt"
    | "unlock.success"
    | "unlock.failure"
    | "unlock.lockout"
    | "password.setup"
    | "password.change"
    | "2fa.enable"
    | "2fa.disable"
    | "2fa.verify"
    | "2fa.recovery",
  detail: {
    method?: "password" | "2fa" | "recovery";
    ipAddress?: string;
    userAgent?: string;
    failureReason?: string;
  } = {},
  severity: AuditSeverity = "info",
): Omit<AuditEvent, "id" | "ts"> {
  return {
    category: "security",
    action,
    severity,
    detail,
  } as Omit<AuditEvent, "id" | "ts">;
}

export function createTokenAuditEvent(
  action: "token.create" | "token.revoke" | "token.use",
  detail: { tokenId: string; tokenName?: string; scopes?: string[] },
  severity: AuditSeverity = "info",
): Omit<AuditEvent, "id" | "ts"> {
  return {
    category: "token",
    action,
    severity,
    detail,
  } as Omit<AuditEvent, "id" | "ts">;
}

export function createAgentAuditEvent(
  action: "tool.execute" | "tool.approve" | "tool.reject" | "tool.error",
  detail: {
    runId: string;
    agentId?: string;
    toolName: string;
    toolCallId: string;
    phase: "start" | "end" | "error";
    input?: Record<string, unknown>;
    output?: unknown;
    durationMs?: number;
  },
  severity: AuditSeverity = "info",
): Omit<AuditEvent, "id" | "ts"> {
  return {
    category: "agent",
    action,
    severity,
    detail,
  } as Omit<AuditEvent, "id" | "ts">;
}
