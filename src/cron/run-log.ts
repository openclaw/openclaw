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

export type CronRunLogSortDir = "asc" | "desc";
export type CronRunLogStatusFilter = "all" | "ok" | "error" | "skipped";

export type ReadCronRunLogPageOptions = {
  limit?: number;
  offset?: number;
  jobId?: string;
  status?: CronRunLogStatusFilter;
  statuses?: CronRunStatus[];
  deliveryStatus?: CronDeliveryStatus;
  deliveryStatuses?: CronDeliveryStatus[];
  query?: string;
  sortDir?: CronRunLogSortDir;
};

export type CronRunLogPageResult = {
  entries: CronRunLogEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
};

type ReadCronRunLogAllPageOptions = Omit<ReadCronRunLogPageOptions, "jobId"> & {
  storePath: string;
  jobNameById?: Record<string, string>;
};

function assertSafeCronRunLogJobId(jobId: string): string {
  const trimmed = jobId.trim();
  if (!trimmed) {
    throw new Error("invalid cron run log job id");
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error("invalid cron run log job id");
  }
  return trimmed;
}

export function resolveCronRunLogPath(params: { storePath: string; jobId: string }) {
  const storePath = path.resolve(params.storePath);
  const dir = path.dirname(storePath);
  const runsDir = path.resolve(dir, "runs");
  const safeJobId = assertSafeCronRunLogJobId(params.jobId);
  const resolvedPath = path.resolve(runsDir, `${safeJobId}.jsonl`);
  if (!resolvedPath.startsWith(`${runsDir}${path.sep}`)) {
    throw new Error("invalid cron run log job id");
  }
  return resolvedPath;
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
  const page = await readCronRunLogEntriesPage(filePath, {
    jobId: opts?.jobId,
    limit,
    offset: 0,
    status: "all",
    sortDir: "desc",
  });
  return page.entries.toReversed();
}

function normalizeRunStatusFilter(status?: string): CronRunLogStatusFilter {
  if (status === "ok" || status === "error" || status === "skipped" || status === "all") {
    return status;
  }
  return "all";
}

function normalizeRunStatuses(opts?: {
  statuses?: CronRunStatus[];
  status?: CronRunLogStatusFilter;
}): CronRunStatus[] | null {
  if (Array.isArray(opts?.statuses) && opts.statuses.length > 0) {
    const filtered = opts.statuses.filter(
      (status): status is CronRunStatus =>
        status === "ok" || status === "error" || status === "skipped",
    );
    if (filtered.length > 0) {
      return Array.from(new Set(filtered));
    }
  }
  const status = normalizeRunStatusFilter(opts?.status);
  if (status === "all") {
    return null;
  }
  return [status];
}

function normalizeDeliveryStatuses(opts?: {
  deliveryStatuses?: CronDeliveryStatus[];
  deliveryStatus?: CronDeliveryStatus;
}): CronDeliveryStatus[] | null {
  if (Array.isArray(opts?.deliveryStatuses) && opts.deliveryStatuses.length > 0) {
    const filtered = opts.deliveryStatuses.filter(
      (status): status is CronDeliveryStatus =>
        status === "delivered" ||
        status === "not-delivered" ||
        status === "unknown" ||
        status === "not-requested",
    );
    if (filtered.length > 0) {
      return Array.from(new Set(filtered));
    }
  }
  if (
    opts?.deliveryStatus === "delivered" ||
    opts?.deliveryStatus === "not-delivered" ||
    opts?.deliveryStatus === "unknown" ||
    opts?.deliveryStatus === "not-requested"
  ) {
    return [opts.deliveryStatus];
  }
  return null;
}

function parseAllRunLogEntries(raw: string, opts?: { jobId?: string }): CronRunLogEntry[] {
  const jobId = opts?.jobId?.trim() || undefined;
  if (!raw.trim()) {
    return [];
  }
  const parsed: CronRunLogEntry[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
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
  return parsed;
}

export async function readCronRunLogEntriesPage(
  filePath: string,
  opts?: ReadCronRunLogPageOptions,
): Promise<CronRunLogPageResult> {
  const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? 50)));
  const raw = await fs.readFile(path.resolve(filePath), "utf-8").catch(() => "");
  const statuses = normalizeRunStatuses(opts);
  const deliveryStatuses = normalizeDeliveryStatuses(opts);
  const query = opts?.query?.trim().toLowerCase() ?? "";
  const sortDir: CronRunLogSortDir = opts?.sortDir === "asc" ? "asc" : "desc";
  const all = parseAllRunLogEntries(raw, { jobId: opts?.jobId });
  const filtered = all.filter((entry) => {
    if (statuses && (!entry.status || !statuses.includes(entry.status))) {
      return false;
    }
    if (deliveryStatuses) {
      const deliveryStatus = entry.deliveryStatus ?? "not-requested";
      if (!deliveryStatuses.includes(deliveryStatus)) {
        return false;
      }
    }
    if (!query) {
      return true;
    }
    const haystack = [entry.summary ?? "", entry.error ?? "", entry.jobId].join(" ").toLowerCase();
    return haystack.includes(query);
  });
  const sorted =
    sortDir === "asc"
      ? filtered.toSorted((a, b) => a.ts - b.ts)
      : filtered.toSorted((a, b) => b.ts - a.ts);
  const total = sorted.length;
  const offset = Math.max(0, Math.min(total, Math.floor(opts?.offset ?? 0)));
  const entries = sorted.slice(offset, offset + limit);
  const nextOffset = offset + entries.length;
  return {
    entries,
    total,
    offset,
    limit,
    hasMore: nextOffset < total,
    nextOffset: nextOffset < total ? nextOffset : null,
  };
}

export async function readCronRunLogEntriesPageAll(
  opts: ReadCronRunLogAllPageOptions,
): Promise<CronRunLogPageResult> {
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const statuses = normalizeRunStatuses(opts);
  const deliveryStatuses = normalizeDeliveryStatuses(opts);
  const query = opts.query?.trim().toLowerCase() ?? "";
  const sortDir: CronRunLogSortDir = opts.sortDir === "asc" ? "asc" : "desc";
  const runsDir = path.resolve(path.dirname(path.resolve(opts.storePath)), "runs");
  const files = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const jsonlFiles = files
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(runsDir, entry.name));
  if (jsonlFiles.length === 0) {
    return {
      entries: [],
      total: 0,
      offset: 0,
      limit,
      hasMore: false,
      nextOffset: null,
    };
  }
  const chunks = await Promise.all(
    jsonlFiles.map(async (filePath) => {
      const raw = await fs.readFile(filePath, "utf-8").catch(() => "");
      return parseAllRunLogEntries(raw);
    }),
  );
  const all = chunks.flat();
  const filtered = all.filter((entry) => {
    if (statuses && (!entry.status || !statuses.includes(entry.status))) {
      return false;
    }
    if (deliveryStatuses) {
      const deliveryStatus = entry.deliveryStatus ?? "not-requested";
      if (!deliveryStatuses.includes(deliveryStatus)) {
        return false;
      }
    }
    if (!query) {
      return true;
    }
    const jobName = opts.jobNameById?.[entry.jobId] ?? "";
    const haystack = [entry.summary ?? "", entry.error ?? "", entry.jobId, jobName]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
  const sorted =
    sortDir === "asc"
      ? filtered.toSorted((a, b) => a.ts - b.ts)
      : filtered.toSorted((a, b) => b.ts - a.ts);
  const total = sorted.length;
  const offset = Math.max(0, Math.min(total, Math.floor(opts.offset ?? 0)));
  const entries = sorted.slice(offset, offset + limit);
  if (opts.jobNameById) {
    for (const entry of entries) {
      const jobName = opts.jobNameById[entry.jobId];
      if (jobName) {
        (entry as CronRunLogEntry & { jobName?: string }).jobName = jobName;
      }
    }
  }
  const nextOffset = offset + entries.length;
  return {
    entries,
    total,
    offset,
    limit,
    hasMore: nextOffset < total,
    nextOffset: nextOffset < total ? nextOffset : null,
  };
}
