import { formatCliCommand } from "../cli/command-format.js";
import {
  deleteOpenClawStateKvJson,
  readOpenClawStateKvJson,
  writeOpenClawStateKvJson,
  type OpenClawStateJsonValue,
} from "../state/openclaw-state-kv.js";
import { resolveRuntimeServiceVersion } from "../version.js";

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

const RESTART_SENTINEL_KV_SCOPE = "gateway.restart-sentinel";
const RESTART_SENTINEL_KV_KEY = "current";

export function formatDoctorNonInteractiveHint(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  return `Run: ${formatCliCommand("openclaw doctor --non-interactive", env)}`;
}

export async function writeRestartSentinel(
  payload: RestartSentinelPayload,
  env: NodeJS.ProcessEnv = process.env,
) {
  const data: RestartSentinel = { version: 1, payload };
  writeOpenClawStateKvJson<OpenClawStateJsonValue>(
    RESTART_SENTINEL_KV_SCOPE,
    RESTART_SENTINEL_KV_KEY,
    data as unknown as OpenClawStateJsonValue,
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
  deleteOpenClawStateKvJson(RESTART_SENTINEL_KV_SCOPE, RESTART_SENTINEL_KV_KEY, { env });
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
  const parsed = readOpenClawStateKvJson(RESTART_SENTINEL_KV_SCOPE, RESTART_SENTINEL_KV_KEY, {
    env,
  });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const sentinel = parsed as unknown as RestartSentinel;
  if (sentinel.version !== 1 || !sentinel.payload) {
    deleteOpenClawStateKvJson(RESTART_SENTINEL_KV_SCOPE, RESTART_SENTINEL_KV_KEY, { env });
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
