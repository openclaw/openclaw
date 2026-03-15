import fs from "node:fs/promises";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";

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

export type RestartSentinelPayload = {
  kind: "config-apply" | "config-patch" | "update" | "restart";
  status: "pending" | "in-progress" | "ok" | "error" | "skipped";
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
  doctorHint?: string | null;
  stats?: RestartSentinelStats | null;
};

export type RestartSentinel = {
  version: 1;
  payload: RestartSentinelPayload;
};

const SENTINEL_FILENAME = "restart-sentinel.json";
const RESTART_SENTINEL_FINALIZE_MAX_AGE_MS = 5 * 60_000;

export function isFinalRestartSentinelStatus(
  status: RestartSentinelPayload["status"],
): status is "ok" | "error" | "skipped" {
  return status === "ok" || status === "error" || status === "skipped";
}

export function formatDoctorNonInteractiveHint(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  return `Run: ${formatCliCommand("openclaw doctor --non-interactive", env)}`;
}

export function resolveRestartSentinelPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), SENTINEL_FILENAME);
}

export async function writeRestartSentinel(
  payload: RestartSentinelPayload,
  env: NodeJS.ProcessEnv = process.env,
) {
  const filePath = resolveRestartSentinelPath(env);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const data: RestartSentinel = { version: 1, payload };
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  return filePath;
}

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

async function rewriteRestartSentinel(
  nextPayload: RestartSentinelPayload,
  env: NodeJS.ProcessEnv = process.env,
) {
  return await writeRestartSentinel(nextPayload, env);
}

export async function transitionRestartSentinelStatus(
  nextStatus: RestartSentinelPayload["status"],
  opts?: {
    allowedCurrentStatuses?: RestartSentinelPayload["status"][];
    env?: NodeJS.ProcessEnv;
  },
): Promise<RestartSentinel | null> {
  const env = opts?.env ?? process.env;
  const sentinel = await readRestartSentinel(env);
  if (!sentinel) {
    return null;
  }
  if (
    opts?.allowedCurrentStatuses &&
    !opts.allowedCurrentStatuses.includes(sentinel.payload.status)
  ) {
    return sentinel;
  }
  const nextPayload: RestartSentinelPayload = {
    ...sentinel.payload,
    status: nextStatus,
    ts: Date.now(),
  };
  await rewriteRestartSentinel(nextPayload, env);
  return { ...sentinel, payload: nextPayload };
}

export async function finalizeRestartSentinelForCompletedRestart(
  env: NodeJS.ProcessEnv = process.env,
  maxAgeMs = RESTART_SENTINEL_FINALIZE_MAX_AGE_MS,
): Promise<RestartSentinel | null> {
  const sentinel = await readRestartSentinel(env);
  if (!sentinel || sentinel.payload.status !== "in-progress") {
    return null;
  }
  if (Date.now() - sentinel.payload.ts > Math.max(0, maxAgeMs)) {
    return null;
  }
  return await transitionRestartSentinelStatus("ok", {
    allowedCurrentStatuses: ["in-progress"],
    env,
  });
}

export async function consumeFinalizedRestartSentinel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  const sentinel = await readRestartSentinel(env);
  if (!sentinel || !isFinalRestartSentinelStatus(sentinel.payload.status)) {
    return null;
  }
  await fs.unlink(resolveRestartSentinelPath(env)).catch(() => {});
  return sentinel;
}

export async function consumeRestartSentinel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  const filePath = resolveRestartSentinelPath(env);
  const parsed = await readRestartSentinel(env);
  if (!parsed) {
    return null;
  }
  await fs.unlink(filePath).catch(() => {});
  return parsed;
}

export function formatRestartSentinelMessage(payload: RestartSentinelPayload): string {
  const message = payload.message?.trim();
  if (message && !payload.stats) {
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
