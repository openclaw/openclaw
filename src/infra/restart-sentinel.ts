import fs from "node:fs/promises";
import path from "node:path";
import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { writeJson } from "./json-files.js";

/** Captured process-output tail for restart/update steps; full logs stay out of the sentinel. */
export type RestartSentinelLog = {
  stdoutTail?: string | null;
  stderrTail?: string | null;
  exitCode?: number | null;
};

/** One restart/update step recorded for post-restart diagnostics. */
export type RestartSentinelStep = {
  name: string;
  command: string;
  cwd?: string | null;
  durationMs?: number | null;
  log?: RestartSentinelLog | null;
};

/** Structured before/after metadata persisted across a Gateway process restart. */
export type RestartSentinelStats = {
  mode?: string;
  root?: string;
  handoffId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  steps?: RestartSentinelStep[];
  reason?: string | null;
  durationMs?: number | null;
};

/** Deferred post-restart action consumed by the next Gateway process. */
export type RestartSentinelContinuation =
  | {
      kind: "systemEvent";
      text: string;
    }
  | {
      kind: "agentTurn";
      message: string;
    };

/**
 * Payload written before restart-like operations so the next Gateway process can
 * report the outcome and optionally resume the originating session/channel.
 */
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

/** Versioned restart sentinel envelope stored on disk for forward-compatible parsing. */
export type RestartSentinel = {
  version: 1;
  payload: RestartSentinelPayload;
};

const SENTINEL_FILENAME = "restart-sentinel.json";

/** Build the approvals-capable follow-up hint shown when doctor cannot run inline. */
export function formatDoctorNonInteractiveHint(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  return `Recommended follow-up: run ${formatCliCommand(
    "openclaw doctor --non-interactive",
    env,
  )} in a terminal or approvals-capable OpenClaw surface.`;
}

/** Resolve the process-state sentinel path from the active OpenClaw state dir. */
export function resolveRestartSentinelPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), SENTINEL_FILENAME);
}

/**
 * Persist a versioned restart sentinel with private state-dir permissions so the
 * next Gateway process can consume it exactly once.
 */
export async function writeRestartSentinel(
  payload: RestartSentinelPayload,
  env: NodeJS.ProcessEnv = process.env,
) {
  const filePath = resolveRestartSentinelPath(env);
  const data: RestartSentinel = { version: 1, payload };
  await writeJson(filePath, data, { trailingNewline: true, dirMode: 0o700 });
  return filePath;
}

function cloneRestartSentinelPayload(payload: RestartSentinelPayload): RestartSentinelPayload {
  return structuredClone(payload);
}

// Rewrite via a clone so helper callbacks cannot mutate the cached/current
// payload if they decide the sentinel kind does not apply.
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

/** Record the running service version after an update restart completes. */
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

/** Mark an update sentinel as failed and drop any continuation that should no longer resume. */
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

/** Best-effort cleanup for a sentinel path captured before launching a restart command. */
export async function removeRestartSentinelFile(filePath: string | null | undefined) {
  if (!filePath) {
    return;
  }
  await fs.unlink(filePath).catch(() => {});
}

/** Convert an optional post-restart message into an agent continuation request. */
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

/**
 * Read and validate the restart sentinel. Malformed or unsupported files are
 * deleted so stale state cannot replay on every Gateway start.
 */
export async function readRestartSentinel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  const filePath = resolveRestartSentinelPath(env);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    let parsed: RestartSentinel | undefined;
    try {
      parsed = JSON.parse(raw) as RestartSentinel | undefined;
    } catch {
      await fs.unlink(filePath).catch(() => {});
      return null;
    }
    if (!parsed || parsed.version !== 1 || !parsed.payload) {
      await fs.unlink(filePath).catch(() => {});
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Read the sentinel and remove the backing file after a successful parse. */
export async function consumeRestartSentinel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  const filePath = resolveRestartSentinelPath(env);
  const parsed = await readRestartSentinel(env);
  if (!parsed) {
    return null;
  }
  await removeRestartSentinelFile(filePath);
  return parsed;
}

/** Format the user-facing restart/update notification without volatile timestamps. */
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

/** Build the stable one-line restart/update summary used by status and notifications. */
export function summarizeRestartSentinel(payload: RestartSentinelPayload): string {
  if (payload.kind === "config-auto-recovery") {
    return "Gateway auto-recovery";
  }
  const kind = payload.kind;
  const status = payload.status;
  const mode = payload.stats?.mode ? ` (${payload.stats.mode})` : "";
  return `Gateway restart ${kind} ${status}${mode}`.trim();
}

/** Trim captured logs from the front so the newest failure context is preserved. */
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
