// Persists short-lived gateway restart handoff metadata.
import { randomUUID } from "node:crypto";
<<<<<<< HEAD
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

// Restart handoff rows let a supervisor explain a recent gateway restart after
// the old process exits. The row is short-lived, bounded, and replaced on write.
export const GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND = "gateway-supervisor-restart-handoff";
const GATEWAY_SUPERVISOR_RESTART_HANDOFF_KEY = "current";
const GATEWAY_RESTART_HANDOFF_TTL_MS = 60_000;
const GATEWAY_RESTART_TRACE_HANDOFF_MAX_DURATION_MS = 10 * 60_000;
=======
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

// Restart handoff files let a supervisor explain a recent gateway restart after
// the old process exits. The file is short-lived, bounded, and regular-file only.
export const GATEWAY_SUPERVISOR_RESTART_HANDOFF_FILENAME =
  "gateway-supervisor-restart-handoff.json";
export const GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND = "gateway-supervisor-restart-handoff";
const GATEWAY_RESTART_HANDOFF_TTL_MS = 60_000;
const GATEWAY_RESTART_TRACE_HANDOFF_MAX_DURATION_MS = 10 * 60_000;
const GATEWAY_RESTART_HANDOFF_MAX_BYTES = 4096;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
const MAX_INTENT_ID_LENGTH = 120;
const MAX_PROCESS_INSTANCE_ID_LENGTH = 120;
const MAX_REASON_LENGTH = 200;

const handoffLog = createSubsystemLogger("restart-handoff");
<<<<<<< HEAD
type GatewayRestartHandoffDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_handoff">;
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

export type GatewayRestartHandoffRestartKind = "full-process" | "update-process";
export type GatewayRestartHandoffSource =
  | "config-write"
  | "gateway-update"
  | "operator-restart"
  | "plugin-change"
  | "signal"
  | "unknown";
export type GatewayRestartHandoffSupervisorMode = "launchd" | "systemd" | "schtasks" | "external";

export type GatewayRestartHandoff = {
  kind: typeof GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND;
  version: 1;
  intentId: string;
  pid: number;
  processInstanceId?: string;
  createdAt: number;
  expiresAt: number;
  reason?: string;
  source: GatewayRestartHandoffSource;
  restartKind: GatewayRestartHandoffRestartKind;
  supervisorMode: GatewayRestartHandoffSupervisorMode;
  restartTrace?: {
    startedAt: number;
    lastAt: number;
  };
};

function formatShortDuration(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms));
  if (clamped < 1000) {
    return `${clamped}ms`;
  }
  const seconds = Math.floor(clamped / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

function formatDiagnosticValue(value: string): string {
  let normalized = "";
  let previousWasSpace = true;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || /\s/u.test(char)) {
      if (!previousWasSpace) {
        normalized += " ";
        previousWasSpace = true;
      }
      continue;
    }
    normalized += char;
    previousWasSpace = false;
  }
  return normalized.trimEnd();
}

/** Format a compact diagnostic for a recently consumed restart handoff. */
export function formatGatewayRestartHandoffDiagnostic(
  handoff: GatewayRestartHandoff,
  now = Date.now(),
): string {
  const reason = handoff.reason ? formatDiagnosticValue(handoff.reason) : undefined;
  const detail = [
    `${handoff.restartKind} via ${handoff.supervisorMode}`,
    `source=${handoff.source}`,
    reason ? `reason=${reason}` : undefined,
    `pid=${handoff.pid}`,
    `age=${formatShortDuration(now - handoff.createdAt)}`,
    `expiresIn=${formatShortDuration(handoff.expiresAt - now)}`,
  ].filter((value): value is string => Boolean(value));
  return `Recent restart handoff: ${detail.join("; ")}`;
}

<<<<<<< HEAD
=======
function resolveGatewayRestartHandoffPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), GATEWAY_SUPERVISOR_RESTART_HANDOFF_FILENAME);
}

function unlinkRegularFileSync(filePath: string): boolean {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.nlink > 1) {
      return false;
    }
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Remove the restart handoff file when it is a regular single-link file. */
export function clearGatewayRestartHandoffSync(env: NodeJS.ProcessEnv = process.env): void {
  unlinkRegularFileSync(resolveGatewayRestartHandoffPath(env));
}

>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
function normalizePid(pid: number | undefined): number | null {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function normalizeText(value: unknown, maxLength: number): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maxLength) : undefined;
}

function normalizeCreatedAt(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : Date.now();
}

function normalizeTtlMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return GATEWAY_RESTART_HANDOFF_TTL_MS;
  }
  return Math.min(Math.floor(value), GATEWAY_RESTART_HANDOFF_TTL_MS);
}

function normalizeRestartTraceHandoff(
  value: unknown,
): GatewayRestartHandoff["restartTrace"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as { startedAt?: unknown; lastAt?: unknown };
  if (
    typeof record.startedAt !== "number" ||
    !Number.isFinite(record.startedAt) ||
    typeof record.lastAt !== "number" ||
    !Number.isFinite(record.lastAt) ||
    record.startedAt <= 0 ||
    record.lastAt < record.startedAt ||
    record.lastAt - record.startedAt > GATEWAY_RESTART_TRACE_HANDOFF_MAX_DURATION_MS
  ) {
    return undefined;
  }
  return {
    startedAt: record.startedAt,
    lastAt: record.lastAt,
  };
}

function normalizeSource(
  source: GatewayRestartHandoffSource | undefined,
  reason: string | undefined,
): GatewayRestartHandoffSource {
  if (source) {
    return source;
  }
  if (!reason) {
    return "unknown";
  }
  const normalized = reason.toLowerCase();
  if (normalized === "update.run") {
    return "gateway-update";
  }
  if (normalized === "sigusr1") {
    return "signal";
  }
  if (normalized === "gateway.restart") {
    return "operator-restart";
  }
  if (normalized.includes("plugin")) {
    return "plugin-change";
  }
  if (normalized.includes("config") || normalized.includes("include")) {
    return "config-write";
  }
  return "unknown";
}

function isSource(value: unknown): value is GatewayRestartHandoffSource {
  return (
    value === "config-write" ||
    value === "gateway-update" ||
    value === "operator-restart" ||
    value === "plugin-change" ||
    value === "signal" ||
    value === "unknown"
  );
}

function isRestartKind(value: unknown): value is GatewayRestartHandoffRestartKind {
  return value === "full-process" || value === "update-process";
}

function isSupervisorMode(value: unknown): value is GatewayRestartHandoffSupervisorMode {
  return value === "launchd" || value === "systemd" || value === "schtasks" || value === "external";
}

<<<<<<< HEAD
function normalizeGatewayRestartHandoffRow(row: {
  kind: string;
  version: number;
  intent_id: string;
  pid: number;
  process_instance_id: string | null;
  created_at: number;
  expires_at: number;
  reason: string | null;
  restart_trace_started_at: number | null;
  restart_trace_last_at: number | null;
  source: string;
  restart_kind: string;
  supervisor_mode: string;
}): GatewayRestartHandoff | null {
  if (
    row.kind !== GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND ||
    row.version !== 1 ||
    typeof row.intent_id !== "string" ||
    row.intent_id.trim().length === 0 ||
    typeof row.pid !== "number" ||
    !Number.isSafeInteger(row.pid) ||
    row.pid <= 0 ||
    typeof row.created_at !== "number" ||
    !Number.isFinite(row.created_at) ||
    typeof row.expires_at !== "number" ||
    !Number.isFinite(row.expires_at) ||
    row.expires_at <= row.created_at ||
    row.expires_at - row.created_at > GATEWAY_RESTART_HANDOFF_TTL_MS ||
    !isSource(row.source) ||
    !isRestartKind(row.restart_kind) ||
    !isSupervisorMode(row.supervisor_mode)
  ) {
    return null;
  }
  const restartTrace = normalizeRestartTraceHandoff(
    row.restart_trace_started_at !== null && row.restart_trace_last_at !== null
      ? { startedAt: row.restart_trace_started_at, lastAt: row.restart_trace_last_at }
      : null,
  );

  const processInstanceId = normalizeText(row.process_instance_id, MAX_PROCESS_INSTANCE_ID_LENGTH);
  const reason = normalizeText(row.reason, MAX_REASON_LENGTH);
  return {
    kind: GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND,
    version: 1,
    intentId: row.intent_id.trim().slice(0, MAX_INTENT_ID_LENGTH),
    pid: row.pid,
    ...(processInstanceId ? { processInstanceId } : {}),
    createdAt: Math.floor(row.created_at),
    expiresAt: Math.floor(row.expires_at),
    ...(reason ? { reason } : {}),
    source: row.source,
    restartKind: row.restart_kind,
    supervisorMode: row.supervisor_mode,
=======
function parseGatewayRestartHandoff(raw: string): GatewayRestartHandoff | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  if (
    parsed.kind !== GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND ||
    parsed.version !== 1 ||
    typeof parsed.intentId !== "string" ||
    parsed.intentId.trim().length === 0 ||
    typeof parsed.pid !== "number" ||
    !Number.isSafeInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    typeof parsed.createdAt !== "number" ||
    !Number.isFinite(parsed.createdAt) ||
    typeof parsed.expiresAt !== "number" ||
    !Number.isFinite(parsed.expiresAt) ||
    parsed.expiresAt <= parsed.createdAt ||
    parsed.expiresAt - parsed.createdAt > GATEWAY_RESTART_HANDOFF_TTL_MS ||
    !isSource(parsed.source) ||
    !isRestartKind(parsed.restartKind) ||
    !isSupervisorMode(parsed.supervisorMode)
  ) {
    return null;
  }
  if (parsed.reason !== undefined && typeof parsed.reason !== "string") {
    return null;
  }
  if (parsed.processInstanceId !== undefined && typeof parsed.processInstanceId !== "string") {
    return null;
  }
  const restartTrace = normalizeRestartTraceHandoff(parsed.restartTrace);

  const processInstanceId = normalizeText(parsed.processInstanceId, MAX_PROCESS_INSTANCE_ID_LENGTH);
  const reason = normalizeText(parsed.reason, MAX_REASON_LENGTH);
  return {
    kind: GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND,
    version: 1,
    intentId: parsed.intentId.trim().slice(0, MAX_INTENT_ID_LENGTH),
    pid: parsed.pid,
    ...(processInstanceId ? { processInstanceId } : {}),
    createdAt: Math.floor(parsed.createdAt),
    expiresAt: Math.floor(parsed.expiresAt),
    ...(reason ? { reason } : {}),
    source: parsed.source,
    restartKind: parsed.restartKind,
    supervisorMode: parsed.supervisorMode,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    ...(restartTrace ? { restartTrace } : {}),
  };
}

<<<<<<< HEAD
function readGatewayRestartHandoffRowSync(env: NodeJS.ProcessEnv) {
  try {
    const { db } = openOpenClawStateDatabase({ env });
    const stateDb = getNodeSqliteKysely<GatewayRestartHandoffDatabase>(db);
    return executeSqliteQueryTakeFirstSync(
      db,
      stateDb
        .selectFrom("gateway_restart_handoff")
        .select([
          "kind",
          "version",
          "intent_id",
          "pid",
          "process_instance_id",
          "created_at",
          "expires_at",
          "reason",
          "restart_trace_started_at",
          "restart_trace_last_at",
          "source",
          "restart_kind",
          "supervisor_mode",
        ])
        .where("handoff_key", "=", GATEWAY_SUPERVISOR_RESTART_HANDOFF_KEY),
    );
=======
function readGatewayRestartHandoffRawSync(env: NodeJS.ProcessEnv): string | null {
  const handoffPath = resolveGatewayRestartHandoffPath(env);
  try {
    const stat = fs.lstatSync(handoffPath);
    // Handoff reads ignore symlinks, hardlinks, and oversized files because the
    // state directory may be user-writable on some installs.
    if (!stat.isFile() || stat.nlink > 1 || stat.size > GATEWAY_RESTART_HANDOFF_MAX_BYTES) {
      return null;
    }
    return fs.readFileSync(handoffPath, "utf8");
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  } catch {
    return null;
  }
}

/** Write the bounded supervisor restart handoff atomically. */
export function writeGatewayRestartHandoffSync(opts: {
  env?: NodeJS.ProcessEnv;
  pid?: number;
  processInstanceId?: string;
  reason?: string;
  source?: GatewayRestartHandoffSource;
  restartKind: GatewayRestartHandoffRestartKind;
  supervisorMode?: GatewayRestartHandoffSupervisorMode | null;
  restartTrace?: GatewayRestartHandoff["restartTrace"];
  ttlMs?: number;
  createdAt?: number;
}): GatewayRestartHandoff | null {
  const pid = normalizePid(opts.pid ?? process.pid);
  if (pid === null || !isRestartKind(opts.restartKind)) {
    return null;
  }
  if (opts.source !== undefined && !isSource(opts.source)) {
    return null;
  }
  const supervisorMode = opts.supervisorMode ?? "external";
  if (!isSupervisorMode(supervisorMode)) {
    return null;
  }

  const env = opts.env ?? process.env;
  const createdAt = normalizeCreatedAt(opts.createdAt);
  const ttlMs = normalizeTtlMs(opts.ttlMs);
  const reason = normalizeText(opts.reason, MAX_REASON_LENGTH);
  const processInstanceId = normalizeText(opts.processInstanceId, MAX_PROCESS_INSTANCE_ID_LENGTH);
  const restartTrace = normalizeRestartTraceHandoff(opts.restartTrace);
  const payload: GatewayRestartHandoff = {
    kind: GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND,
    version: 1,
    intentId: randomUUID(),
    pid,
    ...(processInstanceId ? { processInstanceId } : {}),
    createdAt,
    expiresAt: createdAt + ttlMs,
    ...(reason ? { reason } : {}),
    source: normalizeSource(opts.source, reason),
    restartKind: opts.restartKind,
    supervisorMode,
    ...(restartTrace ? { restartTrace } : {}),
  };

<<<<<<< HEAD
  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const stateDb = getNodeSqliteKysely<GatewayRestartHandoffDatabase>(db);
        executeSqliteQuerySync(
          db,
          stateDb
            .insertInto("gateway_restart_handoff")
            .values({
              handoff_key: GATEWAY_SUPERVISOR_RESTART_HANDOFF_KEY,
              kind: payload.kind,
              version: payload.version,
              intent_id: payload.intentId,
              pid: payload.pid,
              process_instance_id: payload.processInstanceId ?? null,
              created_at: payload.createdAt,
              expires_at: payload.expiresAt,
              reason: payload.reason ?? null,
              restart_trace_started_at: payload.restartTrace?.startedAt ?? null,
              restart_trace_last_at: payload.restartTrace?.lastAt ?? null,
              source: payload.source,
              restart_kind: payload.restartKind,
              supervisor_mode: payload.supervisorMode,
              updated_at_ms: Date.now(),
            })
            .onConflict((conflict) =>
              conflict.column("handoff_key").doUpdateSet({
                kind: (eb) => eb.ref("excluded.kind"),
                version: (eb) => eb.ref("excluded.version"),
                intent_id: (eb) => eb.ref("excluded.intent_id"),
                pid: (eb) => eb.ref("excluded.pid"),
                process_instance_id: (eb) => eb.ref("excluded.process_instance_id"),
                created_at: (eb) => eb.ref("excluded.created_at"),
                expires_at: (eb) => eb.ref("excluded.expires_at"),
                reason: (eb) => eb.ref("excluded.reason"),
                restart_trace_started_at: (eb) => eb.ref("excluded.restart_trace_started_at"),
                restart_trace_last_at: (eb) => eb.ref("excluded.restart_trace_last_at"),
                source: (eb) => eb.ref("excluded.source"),
                restart_kind: (eb) => eb.ref("excluded.restart_kind"),
                supervisor_mode: (eb) => eb.ref("excluded.supervisor_mode"),
                updated_at_ms: (eb) => eb.ref("excluded.updated_at_ms"),
              }),
            ),
        );
      },
      { env },
    );
    return payload;
  } catch (err) {
=======
  let tmpPath: string | undefined;
  try {
    const handoffPath = resolveGatewayRestartHandoffPath(env);
    fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
    tmpPath = path.join(
      path.dirname(handoffPath),
      `.${path.basename(handoffPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
    );
    let fd: number | undefined;
    try {
      fd = fs.openSync(tmpPath, "wx", 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, "utf8");
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
    }
    fs.renameSync(tmpPath, handoffPath);
    return payload;
  } catch (err) {
    if (tmpPath) {
      unlinkRegularFileSync(tmpPath);
    }
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    handoffLog.warn(`failed to write gateway restart handoff: ${String(err)}`);
    return null;
  }
}

/** Read the current unexpired restart handoff without consuming it. */
export function readGatewayRestartHandoffSync(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): GatewayRestartHandoff | null {
<<<<<<< HEAD
  const row = readGatewayRestartHandoffRowSync(env);
  const payload = row ? normalizeGatewayRestartHandoffRow(row) : null;
=======
  const raw = readGatewayRestartHandoffRawSync(env);
  if (!raw) {
    return null;
  }
  const payload = parseGatewayRestartHandoff(raw);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  if (!payload || now < payload.createdAt || now > payload.expiresAt) {
    return null;
  }
  return payload;
}
<<<<<<< HEAD
=======

/** Consume a handoff only when it belongs to the just-exited process. */
export function consumeGatewayRestartHandoffForExitedProcessSync(opts: {
  env?: NodeJS.ProcessEnv;
  exitedPid?: number;
  processInstanceId?: string;
  now?: number;
}): GatewayRestartHandoff | null {
  const env = opts.env ?? process.env;
  const handoffPath = resolveGatewayRestartHandoffPath(env);
  let raw: string | null = null;
  try {
    const stat = fs.lstatSync(handoffPath);
    // Consume uses the same regular-file guard as reads, then clears the file
    // even if parsing fails so stale handoffs do not repeat.
    if (!stat.isFile() || stat.nlink > 1 || stat.size > GATEWAY_RESTART_HANDOFF_MAX_BYTES) {
      return null;
    }
    raw = fs.readFileSync(handoffPath, "utf8");
  } catch {
    return null;
  } finally {
    clearGatewayRestartHandoffSync(env);
  }

  const payload = raw ? parseGatewayRestartHandoff(raw) : null;
  const exitedPid = normalizePid(opts.exitedPid);
  if (!payload || exitedPid === null || payload.pid !== exitedPid) {
    return null;
  }

  const expectedProcessInstanceId = normalizeText(
    opts.processInstanceId,
    MAX_PROCESS_INSTANCE_ID_LENGTH,
  );
  if (expectedProcessInstanceId && payload.processInstanceId !== expectedProcessInstanceId) {
    return null;
  }

  const now = opts.now ?? Date.now();
  if (now < payload.createdAt || now > payload.expiresAt) {
    return null;
  }
  return payload;
}
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
