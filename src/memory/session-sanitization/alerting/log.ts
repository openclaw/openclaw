import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import type { AlertPayload } from "../types.js";

const alertLogWriteChains = new Map<string, Promise<void>>();

function resolveAlertLogFile(agentId: string): string {
  return path.join(
    resolveStateDir(process.env),
    "agents",
    normalizeAgentId(agentId),
    "alerts",
    "alerts.jsonl",
  );
}

function shouldKeepAlertLogLine(line: string, cutoffMs: number): boolean {
  if (!line.trim()) return false;
  try {
    const parsed = JSON.parse(line) as { timestamp?: unknown };
    if (typeof parsed.timestamp !== "string") return true;
    const ts = Date.parse(parsed.timestamp);
    if (!Number.isFinite(ts)) return true;
    return ts >= cutoffMs;
  } catch {
    // Keep malformed lines to avoid destructive loss from a partial write.
    return true;
  }
}

async function pruneAlertLogFile(params: {
  filePath: string;
  retentionDays: number;
  now: number;
}): Promise<void> {
  const retentionMs = Math.max(0, params.retentionDays) * 24 * 60 * 60 * 1000;
  const cutoffMs = params.now - retentionMs;
  let raw: string;
  try {
    raw = await fs.readFile(params.filePath, "utf8");
  } catch {
    return;
  }
  const kept = raw
    .split(/\r?\n/)
    .filter((line) => shouldKeepAlertLogLine(line, cutoffMs))
    .join("\n");
  const normalized = kept.length > 0 ? `${kept}\n` : "";
  await fs.writeFile(params.filePath, normalized, "utf8");
}

async function withAlertLogWriteLock<T>(filePath: string, op: () => Promise<T>): Promise<T> {
  const previous = alertLogWriteChains.get(filePath) ?? Promise.resolve();
  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const nextChain = previous.then(() => current);
  alertLogWriteChains.set(filePath, nextChain);
  await previous;
  try {
    return await op();
  } finally {
    releaseCurrent?.();
    if (alertLogWriteChains.get(filePath) === nextChain) {
      alertLogWriteChains.delete(filePath);
    }
  }
}

/**
 * Append an alert payload to the agent's persistent alert log.
 *
 * Always-on delivery channel — writes regardless of rate limits or dedup state.
 * Failures are logged by the caller; this function throws on I/O error.
 */
export async function appendAlertLogEntry(
  payload: AlertPayload,
  agentId: string,
  options?: { retentionDays?: number; now?: number },
): Promise<void> {
  const filePath = resolveAlertLogFile(agentId);
  await withAlertLogWriteLock(filePath, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    if (typeof options?.retentionDays === "number" && Number.isFinite(options.retentionDays)) {
      await pruneAlertLogFile({
        filePath,
        retentionDays: options.retentionDays,
        now: options.now ?? Date.now(),
      });
    }
    await fs.appendFile(filePath, JSON.stringify(payload) + "\n", "utf8");
  });
}
