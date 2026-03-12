import { formatCliCommand } from "../cli/command-format.js";
import {
  deleteCoreSettingFromDb,
  getCoreSettingFromDb,
  setCoreSettingInDb,
} from "./state-db/core-settings-sqlite.js";

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
  doctorHint?: string | null;
  stats?: RestartSentinelStats | null;
};

export type RestartSentinel = {
  version: 1;
  payload: RestartSentinelPayload;
};

const SCOPE = "gateway";
const KEY = "restart-sentinel";

export function formatDoctorNonInteractiveHint(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  return `Run: ${formatCliCommand("openclaw doctor --non-interactive", env)}`;
}

export async function writeRestartSentinel(
  payload: RestartSentinelPayload,
  _env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const data: RestartSentinel = { version: 1, payload };
  setCoreSettingInDb(SCOPE, KEY, data);
}

export async function readRestartSentinel(
  _env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  const parsed = getCoreSettingFromDb<RestartSentinel>(SCOPE, KEY);
  if (!parsed || parsed.version !== 1 || !parsed.payload) {
    if (parsed) {
      // Malformed entry — clean up
      deleteCoreSettingFromDb(SCOPE, KEY);
    }
    return null;
  }
  return parsed;
}

export async function consumeRestartSentinel(
  _env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  const parsed = await readRestartSentinel();
  if (!parsed) {
    return null;
  }
  deleteCoreSettingFromDb(SCOPE, KEY);
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
