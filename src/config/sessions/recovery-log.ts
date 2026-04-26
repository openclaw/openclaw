import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type SessionRecoveryEventType =
  | "session.bound"
  | "session.meta.recorded"
  | "inbound.received"
  | "inbound.finalized"
  | "routing.resolved"
  | "approval.requested"
  | "approval.delivered"
  | "approval.accepted"
  | "approval.denied"
  | "approval.expired"
  | "compact.requested"
  | "compact.started"
  | "compact.completed"
  | "compact.failed"
  | "subagent.spawn.accepted"
  | "subagent.child.completed"
  | "outbound.sent"
  | "outbound.failed"
  | "wake.scheduled"
  | "wake.fired"
  | (string & {});

export type SessionRecoveryEventSource = {
  kind?: string;
  provider?: string;
  surface?: string;
  channel?: string;
  chatType?: string;
};

export type SessionRecoveryEvent = {
  version: 1;
  eventId: string;
  eventType: SessionRecoveryEventType;
  timestamp: number;
  sessionKey: string;
  sessionId?: string;
  agentId?: string;
  runId?: string;
  turnId?: string;
  source?: SessionRecoveryEventSource;
  details?: Record<string, unknown>;
};

export type AppendSessionRecoveryEventParams = {
  storePath: string;
  eventType: SessionRecoveryEventType;
  sessionKey: string;
  sessionId?: string;
  agentId?: string;
  runId?: string;
  turnId?: string;
  timestamp?: number;
  eventId?: string;
  source?: SessionRecoveryEventSource;
  details?: Record<string, unknown>;
};

export const SESSION_RECOVERY_LOG_FILE = "recovery-events.jsonl";
export const SESSION_RECOVERY_REDACTED_VALUE = "[redacted]";
export const SESSION_RECOVERY_MAX_STRING_LENGTH = 4096;

export function resolveSessionRecoveryLogPath(storePath: string): string {
  const trimmed = storePath.trim();
  if (!trimmed) {
    throw new Error("resolveSessionRecoveryLogPath requires a non-empty storePath");
  }
  return path.join(path.dirname(path.resolve(trimmed)), SESSION_RECOVERY_LOG_FILE);
}

async function tightenSessionRecoveryLogMode(logPath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  await fs.chmod(logPath, 0o600);
}

function isSensitiveRecoveryKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (
    normalized === "token" ||
    normalized.endsWith("token") ||
    normalized.includes("tokenvalue")
  ) {
    return true;
  }
  return [
    "apikey",
    "authorization",
    "bearer",
    "cookie",
    "password",
    "passwd",
    "secret",
  ].some((needle) => normalized.includes(needle));
}

function truncateRecoveryString(value: string): string {
  if (value.length <= SESSION_RECOVERY_MAX_STRING_LENGTH) {
    return value;
  }
  return `${value.slice(0, SESSION_RECOVERY_MAX_STRING_LENGTH)}…[truncated]`;
}

function sanitizeRecoveryValue(
  value: unknown,
  key: string | undefined,
  seen: WeakSet<object>,
): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (key && isSensitiveRecoveryKey(key)) {
    return SESSION_RECOVERY_REDACTED_VALUE;
  }
  if (typeof value === "string") {
    return truncateRecoveryString(value);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeRecoveryValue(entry, undefined, seen))
      .filter((entry) => entry !== undefined);
  }
  if (typeof value !== "object") {
    return undefined;
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  const clean = Object.fromEntries(
    Object.entries(value)
      .map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeRecoveryValue(entryValue, entryKey, seen),
      ])
      .filter(([, entryValue]) => entryValue !== undefined),
  );
  seen.delete(value);
  return Object.keys(clean).length > 0 ? clean : undefined;
}

function cleanRecord<T extends Record<string, unknown>>(record: T | undefined): T | undefined {
  if (!record) {
    return undefined;
  }
  return sanitizeRecoveryValue(record, undefined, new WeakSet()) as T | undefined;
}

export function buildSessionRecoveryEvent(
  params: Omit<AppendSessionRecoveryEventParams, "storePath">,
): SessionRecoveryEvent {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    throw new Error("buildSessionRecoveryEvent requires a non-empty sessionKey");
  }
  return {
    version: 1,
    eventId: params.eventId?.trim() || crypto.randomUUID(),
    eventType: params.eventType,
    timestamp: params.timestamp ?? Date.now(),
    sessionKey,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.runId ? { runId: params.runId } : {}),
    ...(params.turnId ? { turnId: params.turnId } : {}),
    ...(cleanRecord(params.source) ? { source: cleanRecord(params.source) } : {}),
    ...(cleanRecord(params.details) ? { details: cleanRecord(params.details) } : {}),
  };
}

export async function appendSessionRecoveryEvent(
  params: AppendSessionRecoveryEventParams,
): Promise<SessionRecoveryEvent> {
  const logPath = resolveSessionRecoveryLogPath(params.storePath);
  const event = buildSessionRecoveryEvent(params);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify(event)}\n`, { encoding: "utf-8", mode: 0o600 });
  await tightenSessionRecoveryLogMode(logPath);
  return event;
}

export async function readSessionRecoveryEventsForTest(
  storePath: string,
): Promise<SessionRecoveryEvent[]> {
  const logPath = resolveSessionRecoveryLogPath(storePath);
  let raw = "";
  try {
    raw = await fs.readFile(logPath, "utf-8");
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SessionRecoveryEvent);
}
