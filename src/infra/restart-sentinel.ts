// Persists restart sentinel state that coordinates deferred restarts.
import { existsSync } from "node:fs";
import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatCliCommand } from "../cli/command-format.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { formatErrorMessage } from "./errors.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  deleteRestartSentinelRowSync,
  parseRestartSentinelEnvelope,
  readRestartSentinelRowSync,
  writeRestartSentinelRowIfRevisionSync,
  writeRestartSentinelRowSync,
  type RestartSentinel,
  type RestartSentinelContinuation,
  type RestartSentinelPayload,
} from "./restart-sentinel-store.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

export type {
  RestartSentinelContinuation,
  RestartSentinelPayload,
} from "./restart-sentinel-store.js";

const sentinelLog = createSubsystemLogger("restart-sentinel");

export function formatDoctorNonInteractiveHint(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  return `Recommended follow-up: run ${formatCliCommand(
    "openclaw doctor --non-interactive",
    env,
  )} in a terminal or approvals-capable OpenClaw surface.`;
}

export async function writeRestartSentinel(
  payload: RestartSentinelPayload,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel> {
  return runOpenClawStateWriteTransaction(
    ({ db }) => writeRestartSentinelRowSync(db, payload),
    { env },
    { operationLabel: "restart-sentinel.write" },
  );
}

/** Inject a marker into an already-snapshotted state DB without running migrations. */
export function writeRestartSentinelToStateSnapshot(
  payload: RestartSentinelPayload,
  stateDir: string,
): RestartSentinel {
  const databasePath = resolveOpenClawStateSqlitePath({
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
  });
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(databasePath);
  try {
    return runSqliteImmediateTransactionSync(
      database,
      () => writeRestartSentinelRowSync(database, payload),
      {
        databaseLabel: databasePath,
        operationLabel: "restart-sentinel.snapshot-write",
      },
    );
  } finally {
    database.close();
  }
}

function cloneRestartSentinelPayload(payload: RestartSentinelPayload): RestartSentinelPayload {
  return structuredClone(payload);
}

export async function rewriteRestartSentinel(
  rewrite: (payload: RestartSentinelPayload) => RestartSentinelPayload | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const current = readRestartSentinelRowSync(db);
      if (current.kind !== "valid") {
        return null;
      }
      const nextPayload = rewrite(cloneRestartSentinelPayload(current.sentinel.payload));
      return nextPayload
        ? writeRestartSentinelRowIfRevisionSync(db, nextPayload, current.sentinel.revision)
        : null;
    },
    { env },
    { operationLabel: "restart-sentinel.rewrite-current" },
  );
}

export async function finalizeUpdateRestartSentinelRunningVersion(
  version = resolveRuntimeServiceVersion(process.env),
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  return await rewriteRestartSentinel((payload) => {
    if (payload.kind !== "update") {
      return null;
    }
    const stats = payload.stats ? { ...payload.stats } : {};
    const after = isPlainRecord(stats.after) ? { ...stats.after } : {};
    if (after.version === version) {
      return null;
    }
    after.version = version;
    stats.after = after;
    return {
      ...payload,
      stats,
    };
  }, env);
}

export async function markUpdateRestartSentinelFailure(
  reason: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  return await rewriteRestartSentinel((payload) => {
    if (payload.kind !== "update") {
      return null;
    }
    const payloadWithoutContinuation = { ...payload };
    delete payloadWithoutContinuation.continuation;
    const stats = payload.stats ? { ...payload.stats } : {};
    stats.reason = reason;
    return {
      ...payloadWithoutContinuation,
      status: "error",
      stats,
    };
  }, env);
}

export async function clearRestartSentinel(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return runOpenClawStateWriteTransaction(
    ({ db }) => deleteRestartSentinelRowSync(db),
    { env },
    { operationLabel: "restart-sentinel.clear" },
  );
}

export async function clearRestartSentinelIfRevision(
  expectedRevision: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return runOpenClawStateWriteTransaction(
    ({ db }) => deleteRestartSentinelRowSync(db, expectedRevision),
    { env },
    { operationLabel: "restart-sentinel.clear-if-revision" },
  );
}

export function buildRestartSuccessContinuation(params: {
  sessionKey?: string;
  continuationMessage?: string | null;
}): RestartSentinelContinuation | null {
  const message = params.continuationMessage?.trim();
  if (message) {
    return { kind: "agentTurn", message };
  }
  return null;
}

export async function readRestartSentinel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  try {
    const database = openOpenClawStateDatabase({ env });
    const current = readRestartSentinelRowSync(database.db);
    if (current.kind === "invalid") {
      sentinelLog.warn("Ignoring invalid typed restart sentinel row");
      return null;
    }
    return current.kind === "valid" ? current.sentinel : null;
  } catch (err) {
    sentinelLog.warn(`Failed to read restart sentinel: ${formatErrorMessage(err)}`);
    return null;
  }
}

/** Inspect an existing marker without creating tables or running state migrations. */
export function readRestartSentinelReadOnly(
  env: NodeJS.ProcessEnv = process.env,
): RestartSentinel | null {
  const databasePath = resolveOpenClawStateSqlitePath(env);
  if (!existsSync(databasePath)) {
    return null;
  }
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const table = database
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'gateway_restart_sentinel'",
      )
      .get();
    if (!table) {
      return null;
    }
    const columns = new Set(
      (
        database.prepare("PRAGMA table_info(gateway_restart_sentinel)").all() as Array<{
          name?: unknown;
        }>
      ).flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
    );
    if (!["sentinel_key", "payload_json", "updated_at_ms"].every((name) => columns.has(name))) {
      return null;
    }
    const row = database
      .prepare(
        "SELECT payload_json, updated_at_ms FROM gateway_restart_sentinel WHERE sentinel_key = ? LIMIT 1",
      )
      .get("current") as { payload_json?: unknown; updated_at_ms?: unknown } | undefined;
    if (!row) {
      return null;
    }
    if (typeof row.payload_json !== "string" || typeof row.updated_at_ms !== "number") {
      throw new Error(`invalid read-only restart sentinel row: ${databasePath}`);
    }
    const envelope = parseRestartSentinelEnvelope({
      version: 1,
      payload: JSON.parse(row.payload_json) as unknown,
    });
    if (!envelope) {
      throw new Error(`invalid read-only restart sentinel payload: ${databasePath}`);
    }
    return { ...envelope, revision: row.updated_at_ms };
  } finally {
    database.close();
  }
}

export async function hasRestartSentinel(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    const database = openOpenClawStateDatabase({ env });
    const current = readRestartSentinelRowSync(database.db);
    if (current.kind === "invalid") {
      sentinelLog.warn("Ignoring invalid typed restart sentinel row");
      return false;
    }
    return current.kind === "valid";
  } catch (err) {
    sentinelLog.warn(`Failed to check restart sentinel: ${formatErrorMessage(err)}`);
    return false;
  }
}

export function formatRestartSentinelMessage(payload: RestartSentinelPayload): string {
  const message = payload.message?.trim();
  if (message && (!payload.stats || payload.kind === "config-auto-recovery")) {
    return message;
  }
  const lines: string[] = [summarizeRestartSentinel(payload)];
  if (message) {
    lines.push(message);
  }
  const reason = payload.stats?.reason?.trim();
  if (reason && reason !== message) {
    lines.push(`Reason: ${reason}`);
  }
  if (payload.doctorHint?.trim()) {
    lines.push(payload.doctorHint.trim());
  }
  return lines.join("\n");
}

function isRestartRequiredConfigWriteSentinel(payload: RestartSentinelPayload): boolean {
  return (
    (payload.kind === "config-apply" || payload.kind === "config-patch") &&
    payload.status === "ok" &&
    payload.stats?.requiresRestart === true
  );
}

export function summarizeRestartSentinel(payload: RestartSentinelPayload): string {
  if (payload.kind === "config-auto-recovery") {
    return "Gateway auto-recovery";
  }
  if (isRestartRequiredConfigWriteSentinel(payload)) {
    const mode = payload.stats?.mode ? ` (${payload.stats.mode})` : "";
    return `Gateway restart required${mode}`.trim();
  }
  const kind = payload.kind;
  const status = payload.status;
  const mode = payload.stats?.mode ? ` (${payload.stats.mode})` : "";
  const kindSegment = kind === "restart" ? "" : ` ${kind}`;
  return `Gateway restart${kindSegment} ${status}${mode}`.trim();
}

export function trimLogTail(input?: string | null, maxChars = 8000) {
  if (!input) {
    return null;
  }
  const text = input.trimEnd();
  if (text.length <= maxChars) {
    return text;
  }
  return `…${sliceUtf16Safe(text, text.length - maxChars)}`;
}
