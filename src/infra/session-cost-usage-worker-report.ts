import {
  readSessionCostUsageRollupRowsInDatabase,
  type SessionCostUsageDeferredMetadata,
  type SessionCostUsageRollupRow,
} from "./session-cost-usage-cache.kernel.js";
import {
  resolveUsageCostTranscriptFiles,
  type UsageCostCollectionAccess,
} from "./session-cost-usage-collection.js";
import {
  decodeUsageCostPartition,
  USAGE_COST_QUARTER_MS,
  type UsageCostPartition,
} from "./session-cost-usage-partitions.js";
import { readSessionCostUsagePartitionsInDatabase } from "./session-cost-usage-partitions.worker.js";
import {
  createUsageDayKeyFormatter,
  projectSessionCostSummaries,
} from "./session-cost-usage-projection.js";
import {
  decodeUsageCostRollup,
  decodeUsageCostRollupEnvelope,
  type UsageCostRollupEntry,
} from "./session-cost-usage-rollup-codec.js";
import { createSessionUsageRollupData } from "./session-cost-usage-rollup.js";
import { scanUsageCostRollupInWorker } from "./session-cost-usage-worker-refresh.js";
import type {
  UsageCostWorkerOperation,
  UsageCostWorkerResult,
} from "./session-cost-usage-worker.types.js";
import type { UsageCostTranscriptFile, UsageDailyBucket } from "./session-cost-usage.types.js";
import type { EngineConnection } from "./sql-connection.js";
import { runSqliteReadSnapshotSync } from "./sqlite-transaction.js";
import { isTransientSqliteError } from "./unhandled-rejections.js";
import { WorkerTaskError } from "./worker-task-pool.js";

type RollupScan = Omit<Parameters<typeof scanUsageCostRollupInWorker>[0], "file" | "previous">;

/** Prepare bounded cache inputs synchronously inside their shared read snapshot. */
export function prepareUsageCostReportEntry(params: {
  row: SessionCostUsageRollupRow;
  body: (row: SessionCostUsageRollupRow) => Uint8Array | null;
  partitions: (filePath: string) => UsageCostPartition[];
  startMs?: number;
  endMs?: number;
  pricingFingerprint: string;
  throwIfCancelled: () => void;
}) {
  params.throwIfCancelled();
  const blob = params.body(params.row);
  const envelope = decodeUsageCostRollupEnvelope(params.row.valueJson, params.pricingFingerprint);
  params.throwIfCancelled();
  const startMs = params.startMs ?? Number.NEGATIVE_INFINITY;
  const endMs = params.endMs ?? Number.POSITIVE_INFINITY;
  // Exact partial boundaries need individual timestamps. Aligned reports use the
  // committed aggregates; regrouping floating costs may change their final bit.
  const aligned =
    (!Number.isFinite(startMs) || startMs % USAGE_COST_QUARTER_MS === 0) &&
    (!Number.isFinite(endMs) || (endMs + 1) % USAGE_COST_QUARTER_MS === 0);
  const selected =
    blob && envelope?.projection && aligned ? params.partitions(params.row.key) : undefined;
  return { valueJson: params.row.valueJson, blob, envelope, selected };
}

function createUsageCostReportSource(
  params: Omit<Parameters<typeof readUsageCostReportEntry>[0], "prepared" | "file"> & {
    rows: ReadonlyMap<string, SessionCostUsageRollupRow>;
    entries: ReadonlyMap<string, ReturnType<typeof prepareUsageCostReportEntry>>;
    files: ReadonlyMap<string, UsageCostTranscriptFile>;
    deferredPaths: ReadonlySet<string>;
    deferredMetadata: ReadonlyMap<string, SessionCostUsageDeferredMetadata>;
  },
) {
  const consumed = new Set<string>();
  const invalidRows = new Map<string, SessionCostUsageRollupRow>();
  return {
    invalidRows,
    source: {
      deferredPaths: params.deferredPaths,
      deferredMetadata: params.deferredMetadata,
      readRow(filePath: string) {
        consumed.add(filePath);
        return params.rows.get(filePath);
      },
      readBody: (row: SessionCostUsageRollupRow) => params.entries.get(row.key)?.blob ?? null,
      async readEntry(row: SessionCostUsageRollupRow) {
        return readUsageCostReportEntry({
          ...params,
          prepared: params.entries.get(row.key)!,
          file: params.files.get(row.key),
        });
      },
      onInvalidBody(key: string) {
        const row = params.rows.get(key);
        if (row) {
          invalidRows.set(key, row);
        }
      },
      remainingRows: (function* () {
        for (const row of params.rows.values()) {
          if (!consumed.has(row.key)) {
            yield row;
          }
        }
      })(),
    },
  };
}

/** Project captured cache inputs; replay opens its own bounded transcript reads. */
export async function readUsageCostReportEntry(params: {
  prepared: ReturnType<typeof prepareUsageCostReportEntry>;
  file: UsageCostTranscriptFile | undefined;
  startMs?: number;
  endMs?: number;
  dayBucket: UsageDailyBucket;
  scan: RollupScan;
  throwIfCancelled: () => void;
  replayBudget: { remainingBytes: number; deadline: number };
  cacheBudget: { remainingBytes: number };
}): Promise<UsageCostRollupEntry | null | undefined> {
  const { file, scan } = params;
  params.throwIfCancelled();
  const { valueJson, blob, envelope, selected } = params.prepared;
  const cached = decodeUsageCostRollup(
    valueJson,
    scan.pricingFingerprint,
    blob,
    params.cacheBudget,
  );
  params.throwIfCancelled();
  if (!cached || !envelope?.projection) {
    return cached;
  }
  if (!file) {
    return undefined;
  }
  const startMs = params.startMs ?? Number.NEGATIVE_INFINITY;
  const endMs = params.endMs ?? Number.POSITIVE_INFINITY;
  if (selected) {
    const startMonth = Number.isFinite(startMs)
      ? `${new Date(startMs).toISOString().slice(0, 7)}-01`
      : "";
    const endMonth = Number.isFinite(endMs)
      ? `${new Date(endMs).toISOString().slice(0, 7)}-01`
      : "\uffff";
    const expected = envelope.projection.dates.filter((date) => {
      return date >= startMonth && date <= endMonth;
    });
    if (selected.length !== expected.length) {
      return undefined;
    }
    const rollup = createSessionUsageRollupData();
    rollup.untimestamped = cached.rollup.untimestamped;
    for (const partition of selected) {
      params.throwIfCancelled();
      const day = decodeUsageCostPartition(partition.valueJson, partition.blob, params.cacheBudget);
      if (day === null) {
        return null;
      }
      if (!day) {
        return undefined;
      }
      for (const [key, bucket] of Object.entries(day.buckets)) {
        if (bucket.timestampMs >= startMs && bucket.timestampMs <= endMs) {
          rollup.buckets[key] = bucket;
        }
      }
    }
    const formatDay = createUsageDayKeyFormatter(params.dayBucket);
    if (
      Object.values(rollup.buckets).every(
        (bucket) =>
          formatDay(new Date(bucket.firstTimestampMs ?? bucket.timestampMs)) ===
          formatDay(new Date(bucket.lastTimestampMs ?? bucket.timestampMs)),
      )
    ) {
      return { ...cached, rollup };
    }
  }
  const checkpoint = cached.checkpoint;
  const snapshotFile =
    checkpoint.kind === "sqlite"
      ? {
          ...file,
          maxSeq: checkpoint.maxSeq,
          eventCount: checkpoint.eventCount,
          size: checkpoint.size,
          mtimeMs: checkpoint.mtimeMs,
        }
      : { ...file, size: checkpoint.observedSize, mtimeMs: checkpoint.observedMtimeMs };
  const budget = params.replayBudget;
  if (snapshotFile.size > budget.remainingBytes || performance.now() >= budget.deadline) {
    return null;
  }
  budget.remainingBytes -= snapshotFile.size;
  const exhausted = new Error("Usage report replay budget exhausted");
  const checkProgress = () => {
    params.throwIfCancelled();
    if (performance.now() >= budget.deadline) {
      throw exhausted;
    }
  };
  const canonical = await scanUsageCostRollupInWorker({
    ...scan,
    file: snapshotFile,
    checkProgress,
    resolveCosts: async (pairs) => {
      checkProgress();
      const costs = await scan.resolveCosts(pairs);
      checkProgress();
      return costs;
    },
  }).catch((error: unknown) => {
    params.throwIfCancelled();
    if (error === exhausted) {
      return null;
    }
    if (error instanceof WorkerTaskError) {
      throw error;
    }
    // Omit failed replays so the report stays partial without publishing incomplete usage.
    return undefined;
  });
  params.throwIfCancelled();
  if (canonical === null) {
    return null;
  }
  if (!canonical || canonical.checkpoint.anchorHash !== checkpoint.anchorHash) {
    return undefined;
  }
  return { ...canonical, scannedAt: cached.scannedAt };
}

/** Detail reads: exact per-session summaries from rollups and their month partitions. */
export async function projectUsageCostSessionsInWorker(params: {
  operation: Extract<UsageCostWorkerOperation, { kind: "sessions" }>;
  /** Cache keys of `operation.sessions`, in order; undefined for unresolved archives. */
  sessionPaths: ReadonlyArray<string | undefined>;
  access: UsageCostCollectionAccess;
  readCache: <T>(read: (db: EngineConnection) => T, empty: () => T) => Promise<T>;
  scan: RollupScan;
  throwIfCancelled: () => void;
}): Promise<UsageCostWorkerResult> {
  const { operation, sessionPaths, throwIfCancelled } = params;
  const selectedPaths = sessionPaths.filter((path) => path !== undefined);
  // Exact sub-quarter/day-crossing requests share one bounded replay allowance.
  const replayBudget = { remainingBytes: 16 * 1024 * 1024, deadline: performance.now() + 5_000 };
  // Keep retained cache payloads and decoded JSON within one allowance. SQL readers
  // omit individual blobs above 1 MiB and metadata above 64 KiB before materialization.
  // Reserve compact numeric checkpoints before bodies can exhaust the allowance.
  const metadataLimit = Math.min(new Set(selectedPaths).size, 20_000);
  const cacheBudget = {
    remainingBytes: (operation.reportBudgetBytes ?? 32 * 1024 * 1024) - metadataLimit * 256,
    deferredPaths: new Set<string>(),
    deferredMetadata: new Map<string, SessionCostUsageDeferredMetadata>(),
    metadataLimit,
    pricingFingerprint: operation.pricingFingerprint,
  };
  const project = async (
    rows: SessionCostUsageRollupRow[],
    entries: Map<string, ReturnType<typeof prepareUsageCostReportEntry>>,
  ): Promise<UsageCostWorkerResult> => {
    const byPath = new Map(rows.map((row) => [row.key, row]));
    // Uncached sessions remain pending; only cached reports need transcript freshness.
    const sessions = operation.sessions.filter(
      (_, index) =>
        byPath.has(sessionPaths[index] ?? "") ||
        cacheBudget.deferredPaths.has(sessionPaths[index] ?? ""),
    );
    const discovered = sessions.flatMap((session) =>
      session.transcriptFile ? [session.transcriptFile] : [],
    );
    for (const file of discovered) {
      const checkpoint = entries.get(file.filePath)?.envelope?.checkpoint;
      if (checkpoint?.kind !== "sqlite") {
        continue;
      }
      const rewritten = (checkpoint.generation ?? null) !== (file.generation ?? null);
      if (rewritten) {
        // Discovery and reporting crossed a rewrite. Omit the projection without
        // pruning it; an older checkpoint still needs the normal stale refresh.
        cacheBudget.deferredPaths.add(file.filePath);
      }
      if (rewritten ? checkpoint.mtimeMs >= file.mtimeMs : checkpoint.maxSeq > (file.maxSeq ?? 0)) {
        // A same-generation append may publish newer totals after discovery.
        // Across rewrites, the owner's monotonic mutation version orders the
        // snapshots: newer cache waits for rediscovery instead of rebuilding.
        Object.assign(file, {
          size: checkpoint.size,
          mtimeMs: checkpoint.mtimeMs,
          eventCount: checkpoint.eventCount,
          maxSeq: checkpoint.maxSeq,
        });
      }
    }
    const reportFiles = [
      ...discovered,
      ...(await resolveUsageCostTranscriptFiles(
        sessions.filter((session) => !session.transcriptFile).map((session) => session.sessionFile),
        params.access,
      )),
    ];
    const filesByPath = new Map(
      reportFiles.flatMap((file) => (file ? [[file.filePath, file] as const] : [])),
    );
    const report = createUsageCostReportSource({
      rows: byPath,
      entries,
      files: filesByPath,
      deferredPaths: cacheBudget.deferredPaths,
      deferredMetadata: cacheBudget.deferredMetadata,
      startMs: operation.startMs,
      endMs: operation.endMs,
      dayBucket: operation.dayBucket,
      throwIfCancelled,
      replayBudget,
      cacheBudget,
      scan: params.scan,
    });
    const result = {
      kind: "sessions" as const,
      ...(await projectSessionCostSummaries({
        ...report.source,
        ...operation,
        files: sessionPaths.map((filePath) => filesByPath.get(filePath ?? "")),
      })),
      remainingReportBytes: Math.max(0, cacheBudget.remainingBytes),
    };
    throwIfCancelled();
    return { ...result, invalidRows: [...report.invalidRows.values()] };
  };
  const empty = (): {
    rows: SessionCostUsageRollupRow[];
    entries: Map<string, ReturnType<typeof prepareUsageCostReportEntry>>;
  } => ({ rows: [], entries: new Map() });
  try {
    const snapshot = await params.readCache(
      (db) =>
        runSqliteReadSnapshotSync(db, () => {
          const bodies = new Map<string, Uint8Array | null>();
          const rows = readSessionCostUsageRollupRowsInDatabase(db, selectedPaths, {
            includeBody: true,
            throwIfCancelled,
            budget: cacheBudget,
          }).map(({ blob, ...row }) => {
            bodies.set(row.key, blob);
            return row;
          });
          let partitions: Map<string, UsageCostPartition[]> | undefined;
          const entries = new Map(
            rows.map((row) => [
              row.key,
              prepareUsageCostReportEntry({
                row,
                ...operation,
                throwIfCancelled,
                body: (cachedRow) => bodies.get(cachedRow.key) ?? null,
                partitions: (filePath) => {
                  partitions ??= readSessionCostUsagePartitionsInDatabase(
                    db,
                    rows
                      .filter((cachedRow) => !cacheBudget.deferredPaths.has(cachedRow.key))
                      .map((cachedRow) => cachedRow.key),
                    operation.startMs,
                    operation.endMs,
                    throwIfCancelled,
                    cacheBudget,
                  );
                  return partitions.get(filePath) ?? [];
                },
              }),
            ]),
          );
          return { rows, entries };
        }),
      empty,
    );
    return await project(snapshot.rows, snapshot.entries);
  } catch (error) {
    if (!isTransientSqliteError(error)) {
      throw error;
    }
    const fallback = empty();
    return project(fallback.rows, fallback.entries);
  }
}
