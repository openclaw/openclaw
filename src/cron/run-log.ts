import fs from "node:fs/promises";
import path from "node:path";
import type { CronDeliveryStatus, CronRunStatus, CronRunTelemetry } from "./types.js";

export type CronRunLogEntry = {
  ts: number;
  jobId: string;
  action: "finished";
  status?: CronRunStatus;
  error?: string;
  summary?: string;
  delivered?: boolean;
  deliveryStatus?: CronDeliveryStatus;
  deliveryError?: string;
  sessionId?: string;
  sessionKey?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
} & CronRunTelemetry;

export function resolveCronRunLogPath(params: { storePath: string; jobId: string }) {
  const storePath = path.resolve(params.storePath);
  const dir = path.dirname(storePath);
  return path.join(dir, "runs", `${params.jobId}.jsonl`);
}

const writesByPath = new Map<string, Promise<void>>();

export function getPendingCronRunLogWriteCountForTests() {
  return writesByPath.size;
}

async function pruneIfNeeded(filePath: string, opts: { maxBytes: number; keepLines: number }) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || stat.size <= opts.maxBytes) {
    return;
  }

  const raw = await fs.readFile(filePath, "utf-8").catch(() => "");
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const kept = lines.slice(Math.max(0, lines.length - opts.keepLines));
  const { randomBytes } = await import("node:crypto");
  const tmp = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await fs.writeFile(tmp, `${kept.join("\n")}\n`, "utf-8");
  await fs.rename(tmp, filePath);
}

export async function appendCronRunLog(
  filePath: string,
  entry: CronRunLogEntry,
  opts?: { maxBytes?: number; keepLines?: number },
) {
  const resolved = path.resolve(filePath);
  const prev = writesByPath.get(resolved) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.appendFile(resolved, `${JSON.stringify(entry)}\n`, "utf-8");
      await pruneIfNeeded(resolved, {
        maxBytes: opts?.maxBytes ?? 2_000_000,
        keepLines: opts?.keepLines ?? 2_000,
      });
    });
  writesByPath.set(resolved, next);
  try {
    await next;
  } finally {
    if (writesByPath.get(resolved) === next) {
      writesByPath.delete(resolved);
    }
  }
}

export async function readCronRunLogEntries(
  filePath: string,
  opts?: { limit?: number; jobId?: string },
): Promise<CronRunLogEntry[]> {
  const limit = Math.max(1, Math.min(5000, Math.floor(opts?.limit ?? 200)));
  const jobId = opts?.jobId?.trim() || undefined;
  const raw = await fs.readFile(path.resolve(filePath), "utf-8").catch(() => "");
  if (!raw.trim()) {
    return [];
  }
  const parsed: CronRunLogEntry[] = [];
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0 && parsed.length < limit; i--) {
    const line = lines[i]?.trim();
    if (!line) {
      continue;
    }
    try {
      const obj = JSON.parse(line) as Partial<CronRunLogEntry> | null;
      if (!obj || typeof obj !== "object") {
        continue;
      }
      if (obj.action !== "finished") {
        continue;
      }
      if (typeof obj.jobId !== "string" || obj.jobId.trim().length === 0) {
        continue;
      }
      if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts)) {
        continue;
      }
      if (jobId && obj.jobId !== jobId) {
        continue;
      }
      const usage =
        obj.usage && typeof obj.usage === "object"
          ? (obj.usage as Record<string, unknown>)
          : undefined;
      const entry: CronRunLogEntry = {
        ts: obj.ts,
        jobId: obj.jobId,
        action: "finished",
        status: obj.status,
        error: obj.error,
        summary: obj.summary,
        runAtMs: obj.runAtMs,
        durationMs: obj.durationMs,
        nextRunAtMs: obj.nextRunAtMs,
        model: typeof obj.model === "string" && obj.model.trim() ? obj.model : undefined,
        provider:
          typeof obj.provider === "string" && obj.provider.trim() ? obj.provider : undefined,
        usage: usage
          ? {
              input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
              output_tokens:
                typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
              total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
              cache_read_tokens:
                typeof usage.cache_read_tokens === "number" ? usage.cache_read_tokens : undefined,
              cache_write_tokens:
                typeof usage.cache_write_tokens === "number" ? usage.cache_write_tokens : undefined,
            }
          : undefined,
      };
      if (typeof obj.delivered === "boolean") {
        entry.delivered = obj.delivered;
      }
      if (
        obj.deliveryStatus === "delivered" ||
        obj.deliveryStatus === "not-delivered" ||
        obj.deliveryStatus === "unknown" ||
        obj.deliveryStatus === "not-requested"
      ) {
        entry.deliveryStatus = obj.deliveryStatus;
      }
      if (typeof obj.deliveryError === "string") {
        entry.deliveryError = obj.deliveryError;
      }
      if (typeof obj.sessionId === "string" && obj.sessionId.trim().length > 0) {
        entry.sessionId = obj.sessionId;
      }
      if (typeof obj.sessionKey === "string" && obj.sessionKey.trim().length > 0) {
        entry.sessionKey = obj.sessionKey;
      }
      parsed.push(entry);
    } catch {
      // ignore invalid lines
    }
  }
  return parsed.toReversed();
}
