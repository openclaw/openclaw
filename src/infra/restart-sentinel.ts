import type { Insertable, Selectable } from "kysely";
import { formatCliCommand } from "../cli/command-format.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

export type RestartSentinelLog = {
  stdoutTail?: string | null;
  stderrTail?: string | null;
  exitCode?: number | null;
};

export type RestartSentinelStep = {
  name: string;
  command: string;
  cwd?: string | null;
  durationMs?: number | null;
  log?: RestartSentinelLog | null;
};

export type RestartSentinelStats = {
  mode?: string;
  root?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  steps?: RestartSentinelStep[];
  reason?: string | null;
  durationMs?: number | null;
};

export type RestartSentinelContinuation =
  | {
      kind: "systemEvent";
      text: string;
    }
  | {
      kind: "agentTurn";
      message: string;
    };

export type RestartSentinelPayload = {
  kind: "config-apply" | "config-auto-recovery" | "config-patch" | "update" | "restart";
  status: "ok" | "error" | "skipped";
  ts: number;
  sessionKey?: string;
  /** Delivery context captured at restart time to ensure channel routing survives restart. */
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
  };
  /** Thread ID for reply threading (e.g., Slack thread_ts). */
  threadId?: string;
  message?: string | null;
  continuation?: RestartSentinelContinuation | null;
  doctorHint?: string | null;
  stats?: RestartSentinelStats | null;
};

export type RestartSentinel = {
  version: 1;
  payload: RestartSentinelPayload;
};

export const DEFAULT_RESTART_SUCCESS_CONTINUATION_MESSAGE =
  "The gateway restart completed successfully. Tell the user OpenClaw restarted successfully and continue any pending work.";

const RESTART_SENTINEL_KEY = "current";

type RestartSentinelDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_sentinel">;
type RestartSentinelRow = Selectable<RestartSentinelDatabase["gateway_restart_sentinel"]>;
type RestartSentinelInsert = Insertable<RestartSentinelDatabase["gateway_restart_sentinel"]>;

function restartSentinelToRow(payload: RestartSentinelPayload): RestartSentinelInsert {
  return {
    sentinel_key: RESTART_SENTINEL_KEY,
    version: 1,
    kind: payload.kind,
    status: payload.status,
    ts: payload.ts,
    session_key: payload.sessionKey ?? null,
    thread_id: payload.threadId ?? null,
    delivery_channel: payload.deliveryContext?.channel ?? null,
    delivery_to: payload.deliveryContext?.to ?? null,
    delivery_account_id: payload.deliveryContext?.accountId ?? null,
    message: payload.message ?? null,
    continuation_json: payload.continuation ? JSON.stringify(payload.continuation) : null,
    doctor_hint: payload.doctorHint ?? null,
    stats_json: payload.stats ? JSON.stringify(payload.stats) : null,
    payload_json: JSON.stringify(payload),
    updated_at_ms: Date.now(),
  };
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseRestartSentinelContinuation(
  value: string | null,
): RestartSentinelContinuation | null {
  const parsed = parseJsonRecord(value);
  if (!parsed) {
    return null;
  }
  if (parsed.kind === "systemEvent" && typeof parsed.text === "string") {
    return { kind: "systemEvent", text: parsed.text };
  }
  if (parsed.kind === "agentTurn" && typeof parsed.message === "string") {
    return { kind: "agentTurn", message: parsed.message };
  }
  return null;
}

function rowToRestartSentinel(row: RestartSentinelRow): RestartSentinel | null {
  if (row.version !== 1) {
    return null;
  }
  return {
    version: 1,
    payload: {
      kind: row.kind as RestartSentinelPayload["kind"],
      status: row.status as RestartSentinelPayload["status"],
      ts: row.ts,
      ...(row.session_key ? { sessionKey: row.session_key } : {}),
      ...(row.delivery_channel || row.delivery_to || row.delivery_account_id
        ? {
            deliveryContext: {
              ...(row.delivery_channel ? { channel: row.delivery_channel } : {}),
              ...(row.delivery_to ? { to: row.delivery_to } : {}),
              ...(row.delivery_account_id ? { accountId: row.delivery_account_id } : {}),
            },
          }
        : {}),
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
      ...(row.message != null ? { message: row.message } : {}),
      ...(row.continuation_json
        ? { continuation: parseRestartSentinelContinuation(row.continuation_json) }
        : {}),
      ...(row.doctor_hint != null ? { doctorHint: row.doctor_hint } : {}),
      ...(row.stats_json ? { stats: parseJsonRecord(row.stats_json) as RestartSentinelStats } : {}),
    },
  };
}

function readRestartSentinelRow(env: NodeJS.ProcessEnv): RestartSentinelRow | null {
  const database = openOpenClawStateDatabase({ env });
  const db = getNodeSqliteKysely<RestartSentinelDatabase>(database.db);
  return (
    executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("gateway_restart_sentinel")
        .selectAll()
        .where("sentinel_key", "=", RESTART_SENTINEL_KEY),
    ) ?? null
  );
}

export function formatDoctorNonInteractiveHint(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  return `Run: ${formatCliCommand("openclaw doctor --non-interactive", env)}`;
}

export async function writeRestartSentinel(
  payload: RestartSentinelPayload,
  env: NodeJS.ProcessEnv = process.env,
) {
  const row = restartSentinelToRow(payload);
  const { sentinel_key: _sentinelKey, ...updates } = row;
  runOpenClawStateWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<RestartSentinelDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("gateway_restart_sentinel")
          .values(row)
          .onConflict((conflict) => conflict.column("sentinel_key").doUpdateSet(updates)),
      );
    },
    { env },
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cloneRestartSentinelPayload(payload: RestartSentinelPayload): RestartSentinelPayload {
  return JSON.parse(JSON.stringify(payload)) as RestartSentinelPayload;
}

async function rewriteRestartSentinel(
  rewrite: (payload: RestartSentinelPayload) => RestartSentinelPayload | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  const current = await readRestartSentinel(env);
  if (!current) {
    return null;
  }
  const nextPayload = rewrite(cloneRestartSentinelPayload(current.payload));
  if (!nextPayload) {
    return null;
  }
  await writeRestartSentinel(nextPayload, env);
  return {
    version: 1,
    payload: nextPayload,
  };
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
    const stats = payload.stats ? { ...payload.stats } : {};
    stats.reason = reason;
    return {
      ...payload,
      status: "error",
      stats,
    };
  }, env);
}

export async function clearRestartSentinel(env: NodeJS.ProcessEnv = process.env) {
  runOpenClawStateWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<RestartSentinelDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("gateway_restart_sentinel").where("sentinel_key", "=", RESTART_SENTINEL_KEY),
      );
    },
    { env },
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
  return params.sessionKey?.trim()
    ? { kind: "agentTurn", message: DEFAULT_RESTART_SUCCESS_CONTINUATION_MESSAGE }
    : null;
}

export async function readRestartSentinel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  const row = readRestartSentinelRow(env);
  if (!row) {
    return null;
  }
  const sentinel = rowToRestartSentinel(row);
  if (!sentinel) {
    await clearRestartSentinel(env);
    return null;
  }
  return sentinel;
}

export async function hasRestartSentinel(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return (await readRestartSentinel(env)) !== null;
}

export async function consumeRestartSentinel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  const parsed = await readRestartSentinel(env);
  if (!parsed) {
    return null;
  }
  await clearRestartSentinel(env);
  return parsed;
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

export function summarizeRestartSentinel(payload: RestartSentinelPayload): string {
  if (payload.kind === "config-auto-recovery") {
    return "Gateway auto-recovery";
  }
  const kind = payload.kind;
  const status = payload.status;
  const mode = payload.stats?.mode ? ` (${payload.stats.mode})` : "";
  return `Gateway restart ${kind} ${status}${mode}`.trim();
}

export function trimLogTail(input?: string | null, maxChars = 8000) {
  if (!input) {
    return null;
  }
  const text = input.trimEnd();
  if (text.length <= maxChars) {
    return text;
  }
  return `…${text.slice(text.length - maxChars)}`;
}
