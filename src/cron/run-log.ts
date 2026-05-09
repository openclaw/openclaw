import fs from "node:fs/promises";
import path from "node:path";
import type { Insertable } from "kysely";
import { parseByteSize } from "../cli/parse-bytes.js";
import type { CronConfig } from "../config/types.cron.js";
import { pathExists, root as fsRoot } from "../infra/fs-safe.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "../shared/string-coerce.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { normalizeCronRunDiagnostics } from "./run-diagnostics.js";
import type {
  CronDeliveryStatus,
  CronDeliveryTrace,
  CronRunDiagnostics,
  CronRunStatus,
  CronRunTelemetry,
} from "./types.js";

export type CronRunLogEntry = {
  ts: number;
  jobId: string;
  action: "finished";
  status?: CronRunStatus;
  error?: string;
  summary?: string;
  diagnostics?: CronRunDiagnostics;
  delivered?: boolean;
  deliveryStatus?: CronDeliveryStatus;
  deliveryError?: string;
  delivery?: CronDeliveryTrace;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
} & CronRunTelemetry;

type CronRunLogSortDir = "asc" | "desc";
type CronRunLogStatusFilter = "all" | "ok" | "error" | "skipped";

type ReadCronRunLogPageOptions = {
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

type CronRunLogPageResult = {
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

export async function legacyCronRunLogFilesExist(storePath: string): Promise<boolean> {
  const runsDir = path.resolve(path.dirname(path.resolve(storePath)), "runs");
  if (!(await pathExists(runsDir))) {
    return false;
  }
  const runsRoot = await fsRoot(runsDir).catch(() => null);
  if (!runsRoot) {
    return false;
  }
  const files = await runsRoot.list(".", { withFileTypes: true }).catch(() => []);
  return files.some((entry) => entry.isFile && entry.name.endsWith(".jsonl"));
}

const writesByStoreKey = new Map<string, Promise<void>>();

export const DEFAULT_CRON_RUN_LOG_MAX_BYTES = 2_000_000;
export const DEFAULT_CRON_RUN_LOG_KEEP_LINES = 2_000;

export function resolveCronRunLogPruneOptions(cfg?: CronConfig["runLog"]): {
  maxBytes: number;
  keepLines: number;
} {
  let maxBytes = DEFAULT_CRON_RUN_LOG_MAX_BYTES;
  if (cfg?.maxBytes !== undefined) {
    try {
      const configuredMaxBytes = normalizeStringifiedOptionalString(cfg.maxBytes);
      if (configuredMaxBytes) {
        maxBytes = parseByteSize(configuredMaxBytes, { defaultUnit: "b" });
      }
    } catch {
      maxBytes = DEFAULT_CRON_RUN_LOG_MAX_BYTES;
    }
  }

  let keepLines = DEFAULT_CRON_RUN_LOG_KEEP_LINES;
  if (typeof cfg?.keepLines === "number" && Number.isFinite(cfg.keepLines) && cfg.keepLines > 0) {
    keepLines = Math.floor(cfg.keepLines);
  }

  return { maxBytes, keepLines };
}

function resolveCronRunLogStoreKey(storePath: string): string {
  return path.resolve(storePath);
}

type CronRunLogRow = {
  entry_json: string;
};

type CronRunLogsTable = OpenClawStateKyselyDatabase["cron_run_logs"];
type CronRunLogDatabase = Pick<OpenClawStateKyselyDatabase, "cron_run_logs">;

type CronRunLogPruneRow = {
  seq: number | bigint;
  entry_json: string;
};

function rowToCronRunLogEntry(row: CronRunLogRow): CronRunLogEntry | null {
  const entries = parseAllRunLogEntries(`${row.entry_json}\n`);
  return entries[0] ?? null;
}

function getCronRunLogKysely(db: import("node:sqlite").DatabaseSync) {
  return getNodeSqliteKysely<CronRunLogDatabase>(db);
}

function selectNextCronRunLogSeq(params: {
  db: import("node:sqlite").DatabaseSync;
  storeKey: string;
  jobId: string;
}): number {
  const row = executeSqliteQueryTakeFirstSync(
    params.db,
    getCronRunLogKysely(params.db)
      .selectFrom("cron_run_logs")
      .select((eb) =>
        eb(eb.fn.coalesce(eb.fn.max<number | bigint>("seq"), eb.lit(0)), "+", eb.lit(1)).as(
          "next_seq",
        ),
      )
      .where("store_key", "=", params.storeKey)
      .where("job_id", "=", params.jobId),
  );
  const rawSeq = row?.next_seq ?? 1;
  return typeof rawSeq === "bigint" ? Number(rawSeq) : rawSeq;
}

function insertCronRunLogRow(
  db: import("node:sqlite").DatabaseSync,
  row: Insertable<CronRunLogsTable>,
): void {
  executeSqliteQuerySync(db, getCronRunLogKysely(db).insertInto("cron_run_logs").values(row));
}

function pruneCronRunLogRows(params: {
  db: import("node:sqlite").DatabaseSync;
  storeKey: string;
  jobId: string;
  maxBytes: number;
  keepLines: number;
}): void {
  const rows = executeSqliteQuerySync(
    params.db,
    getCronRunLogKysely(params.db)
      .selectFrom("cron_run_logs")
      .select(["seq", "entry_json"])
      .where("store_key", "=", params.storeKey)
      .where("job_id", "=", params.jobId)
      .orderBy("ts", "desc")
      .orderBy("seq", "desc"),
  ).rows;
  let runningBytes = 0;
  const deleteSeqs: number[] = [];
  rows.forEach((row, index) => {
    runningBytes += row.entry_json.length + 1;
    if (index + 1 > params.keepLines || runningBytes > params.maxBytes) {
      deleteSeqs.push(Number(row.seq));
    }
  });
  if (deleteSeqs.length === 0) {
    return;
  }
  executeSqliteQuerySync(
    params.db,
    getCronRunLogKysely(params.db)
      .deleteFrom("cron_run_logs")
      .where("store_key", "=", params.storeKey)
      .where("job_id", "=", params.jobId)
      .where("seq", "in", deleteSeqs),
  );
}

function insertCronRunLogEntry(params: {
  storePath: string;
  entry: CronRunLogEntry;
  maxBytes: number;
  keepLines: number;
}) {
  assertSafeCronRunLogJobId(params.entry.jobId);
  const storeKey = resolveCronRunLogStoreKey(params.storePath);
  const entryJson = JSON.stringify(params.entry);
  runOpenClawStateWriteTransaction((database) => {
    const seq = selectNextCronRunLogSeq({
      db: database.db,
      storeKey,
      jobId: params.entry.jobId,
    });
    insertCronRunLogRow(database.db, {
      store_key: storeKey,
      job_id: params.entry.jobId,
      seq,
      ts: params.entry.ts,
      entry_json: entryJson,
      created_at: Date.now(),
    });
    pruneCronRunLogRows({
      db: database.db,
      storeKey,
      jobId: params.entry.jobId,
      keepLines: params.keepLines,
      maxBytes: params.maxBytes,
    });
  });
}

async function drainPendingStoreWrite(storePath: string): Promise<void> {
  const pending = writesByStoreKey.get(resolveCronRunLogStoreKey(storePath));
  if (pending) {
    await pending.catch(() => undefined);
  }
}

export async function appendCronRunLogToSqlite(
  storePath: string,
  entry: CronRunLogEntry,
  opts?: { maxBytes?: number; keepLines?: number },
) {
  const storeKey = resolveCronRunLogStoreKey(storePath);
  const prev = writesByStoreKey.get(storeKey) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => {
      insertCronRunLogEntry({
        storePath,
        entry,
        maxBytes: opts?.maxBytes ?? DEFAULT_CRON_RUN_LOG_MAX_BYTES,
        keepLines: opts?.keepLines ?? DEFAULT_CRON_RUN_LOG_KEEP_LINES,
      });
    });
  writesByStoreKey.set(storeKey, next);
  try {
    await next;
  } finally {
    if (writesByStoreKey.get(storeKey) === next) {
      writesByStoreKey.delete(storeKey);
    }
  }
}

export function readCronRunLogEntriesFromSqliteSync(
  storePath: string,
  opts?: { limit?: number; jobId?: string },
): CronRunLogEntry[] {
  const jobId = normalizeOptionalString(opts?.jobId);
  if (!jobId) {
    return [];
  }
  assertSafeCronRunLogJobId(jobId);
  const limit = Math.max(1, Math.min(5000, Math.floor(opts?.limit ?? 200)));
  const database = openOpenClawStateDatabase();
  const rows = executeSqliteQuerySync(
    database.db,
    getCronRunLogKysely(database.db)
      .selectFrom("cron_run_logs")
      .select(["entry_json"])
      .where("store_key", "=", resolveCronRunLogStoreKey(storePath))
      .where("job_id", "=", jobId)
      .orderBy("ts", "desc")
      .orderBy("seq", "desc")
      .limit(limit),
  ).rows;
  return rows
    .map(rowToCronRunLogEntry)
    .filter((entry): entry is CronRunLogEntry => Boolean(entry))
    .toReversed();
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
  const jobId = normalizeOptionalString(opts?.jobId);
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
        runId: typeof obj.runId === "string" && obj.runId.trim() ? obj.runId : undefined,
        diagnostics: normalizeCronRunDiagnostics(obj.diagnostics),
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
      if (obj.delivery && typeof obj.delivery === "object") {
        entry.delivery = obj.delivery;
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

function filterRunLogEntries(
  entries: CronRunLogEntry[],
  opts: {
    statuses: CronRunStatus[] | null;
    deliveryStatuses: CronDeliveryStatus[] | null;
    query: string;
    queryTextForEntry: (entry: CronRunLogEntry) => string;
  },
): CronRunLogEntry[] {
  return entries.filter((entry) => {
    if (opts.statuses && (!entry.status || !opts.statuses.includes(entry.status))) {
      return false;
    }
    if (opts.deliveryStatuses) {
      const deliveryStatus = entry.deliveryStatus ?? "not-requested";
      if (!opts.deliveryStatuses.includes(deliveryStatus)) {
        return false;
      }
    }
    if (!opts.query) {
      return true;
    }
    return normalizeLowercaseStringOrEmpty(opts.queryTextForEntry(entry)).includes(opts.query);
  });
}

function pageRunLogEntries(
  entries: CronRunLogEntry[],
  opts: ReadCronRunLogPageOptions = {},
  queryTextForEntry?: (entry: CronRunLogEntry) => string,
) {
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const statuses = normalizeRunStatuses(opts);
  const deliveryStatuses = normalizeDeliveryStatuses(opts);
  const query = normalizeLowercaseStringOrEmpty(opts.query);
  const sortDir: CronRunLogSortDir = opts.sortDir === "asc" ? "asc" : "desc";
  const filtered = filterRunLogEntries(entries, {
    statuses,
    deliveryStatuses,
    query,
    queryTextForEntry:
      queryTextForEntry ??
      ((entry) =>
        [
          entry.summary ?? "",
          entry.error ?? "",
          entry.diagnostics?.summary ?? "",
          ...(entry.diagnostics?.entries ?? []).map((diagnostic) => diagnostic.message),
          entry.jobId,
          entry.delivery?.intended?.channel ?? "",
          entry.delivery?.resolved?.channel ?? "",
          ...(entry.delivery?.messageToolSentTo ?? []).map((target) => target.channel),
        ].join(" ")),
  });
  const sorted =
    sortDir === "asc"
      ? filtered.toSorted((a, b) => a.ts - b.ts)
      : filtered.toSorted((a, b) => b.ts - a.ts);
  const total = sorted.length;
  const offset = Math.max(0, Math.min(total, Math.floor(opts.offset ?? 0)));
  const pageEntries = sorted.slice(offset, offset + limit);
  const nextOffset = offset + pageEntries.length;
  return {
    entries: pageEntries,
    total,
    offset,
    limit,
    hasMore: nextOffset < total,
    nextOffset: nextOffset < total ? nextOffset : null,
  };
}

export async function readCronRunLogEntriesPageFromSqlite(
  storePath: string,
  opts?: ReadCronRunLogPageOptions,
): Promise<CronRunLogPageResult> {
  await drainPendingStoreWrite(storePath);
  const jobId = normalizeOptionalString(opts?.jobId);
  if (!jobId) {
    return {
      entries: [],
      total: 0,
      offset: 0,
      limit: Math.max(1, Math.min(200, Math.floor(opts?.limit ?? 50))),
      hasMore: false,
      nextOffset: null,
    };
  }
  assertSafeCronRunLogJobId(jobId);
  const database = openOpenClawStateDatabase();
  const rows = executeSqliteQuerySync(
    database.db,
    getCronRunLogKysely(database.db)
      .selectFrom("cron_run_logs")
      .select(["entry_json"])
      .where("store_key", "=", resolveCronRunLogStoreKey(storePath))
      .where("job_id", "=", jobId)
      .orderBy("ts", "asc")
      .orderBy("seq", "asc"),
  ).rows;
  const entries = rows
    .map(rowToCronRunLogEntry)
    .filter((entry): entry is CronRunLogEntry => Boolean(entry));
  return pageRunLogEntries(entries, opts);
}

export async function readCronRunLogEntriesPageAllFromSqlite(
  opts: ReadCronRunLogAllPageOptions,
): Promise<CronRunLogPageResult> {
  await drainPendingStoreWrite(opts.storePath);
  const database = openOpenClawStateDatabase();
  const rows = executeSqliteQuerySync(
    database.db,
    getCronRunLogKysely(database.db)
      .selectFrom("cron_run_logs")
      .select(["entry_json"])
      .where("store_key", "=", resolveCronRunLogStoreKey(opts.storePath))
      .orderBy("ts", "asc")
      .orderBy("seq", "asc"),
  ).rows;
  const entries = rows
    .map(rowToCronRunLogEntry)
    .filter((entry): entry is CronRunLogEntry => Boolean(entry));
  const page = pageRunLogEntries(entries, opts, (entry) => {
    const jobName = opts.jobNameById?.[entry.jobId] ?? "";
    return [
      entry.summary ?? "",
      entry.error ?? "",
      entry.diagnostics?.summary ?? "",
      ...(entry.diagnostics?.entries ?? []).map((diagnostic) => diagnostic.message),
      entry.jobId,
      jobName,
      entry.delivery?.intended?.channel ?? "",
      entry.delivery?.resolved?.channel ?? "",
      ...(entry.delivery?.messageToolSentTo ?? []).map((target) => target.channel),
    ].join(" ");
  });
  if (opts.jobNameById) {
    for (const entry of page.entries) {
      const jobName = opts.jobNameById[entry.jobId];
      if (jobName) {
        (entry as CronRunLogEntry & { jobName?: string }).jobName = jobName;
      }
    }
  }
  return page;
}

export async function importLegacyCronRunLogFilesToSqlite(params: {
  storePath: string;
  opts?: { maxBytes?: number; keepLines?: number };
}): Promise<{ imported: number; files: number; removedDir?: string }> {
  const runsDir = path.resolve(path.dirname(path.resolve(params.storePath)), "runs");
  if (!(await pathExists(runsDir))) {
    return { imported: 0, files: 0 };
  }
  const runsRoot = await fsRoot(runsDir).catch(() => null);
  if (!runsRoot) {
    return { imported: 0, files: 0 };
  }
  const files = (await runsRoot.list(".", { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name);
  let imported = 0;
  for (const fileName of files) {
    const raw = await runsRoot.readText(fileName).catch(() => "");
    for (const entry of parseAllRunLogEntries(raw)) {
      await appendCronRunLogToSqlite(params.storePath, entry, params.opts);
      imported++;
    }
    await fs.rm(path.join(runsDir, fileName), { force: true }).catch(() => undefined);
  }
  let removedDir: string | undefined;
  try {
    const remaining = await runsRoot.list(".", { withFileTypes: true });
    if (remaining.length === 0) {
      await fs.rmdir(runsDir);
      removedDir = runsDir;
    }
  } catch {
    // best-effort cleanup only
  }
  return { imported, files: files.length, removedDir };
}
