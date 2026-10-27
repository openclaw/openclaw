import {
  parseSqliteSessionFileMarker,
  type SqliteSessionFileMarker,
} from "../config/sessions/legacy-sqlite-marker.js";
import { createUsageCalendar } from "../shared/usage-calendar.js";
import type { SessionCostUsageRollupRow } from "./session-cost-usage-cache.kernel.js";
import {
  resolveUsageCostTranscriptFiles,
  resolveUsageCostTranscriptPaths,
  type UsageCostCollectionAccess,
} from "./session-cost-usage-collection.js";
import { createUsageOverviewBatchBuilder } from "./session-cost-usage-overview-batch.js";
import { expandUsageOverviewFamilies } from "./session-cost-usage-overview-load.js";
import {
  createUsageDayKeyFormatter,
  finishUsageCostSummary,
} from "./session-cost-usage-projection.js";
import { addUsageQuartersToDailyTotals } from "./session-cost-usage-quarters-columns.js";
import { createUsageOverviewFold } from "./session-cost-usage-quarters-fold.js";
import {
  createUsageQuarterRange,
  decodeUsageCostQuarters,
  usageQuartersNeedTranscript,
  type UsageCostQuarterBlock,
} from "./session-cost-usage-quarters.js";
import {
  readUsageCostQuarterSnapshotInDatabase,
  type UsageCostQuarterSnapshotEntry,
} from "./session-cost-usage-quarters.worker.js";
import {
  canUseUsageCostRollupForPartial,
  decodeUsageCostRollup,
  isUsageCostRollupFresh,
} from "./session-cost-usage-rollup-codec.js";
import { addRollupToCostUsageSummary } from "./session-cost-usage-rollup.js";
import { createEmptyCostUsageTotals } from "./session-cost-usage-totals.js";
import { readUsageCostReportEntry } from "./session-cost-usage-worker-report.js";
import type {
  UsageCostWorkerOperation,
  UsageCostWorkerResult,
} from "./session-cost-usage-worker.types.js";
import type {
  CostUsageTotals,
  UsageCacheStatus,
  UsageCostTranscriptFile,
} from "./session-cost-usage.types.js";
import type { EngineConnection } from "./sql-connection.js";
import { runSqliteReadSnapshotSync } from "./sqlite-transaction.js";

const USAGE_AGGREGATE_BOUNDARY_MESSAGE =
  "Some usage needs transcript details for this date range or time zone. Select a session for exact usage.";

type QuarterOperation = Extract<UsageCostWorkerOperation, { kind: "overview" | "summary" }>;

type InstanceState =
  | {
      state: "covered";
      blocks: UsageCostQuarterBlock[];
      untimestamped?: NonNullable<
        ReturnType<typeof decodeUsageCostRollup>
      >["rollup"]["untimestamped"];
      computedAt: number;
      fresh: boolean;
    }
  /** Not summarized yet: missing, stale, rebuilding, or awaiting quarter backfill. */
  | { state: "pending" }
  /** Covered data cannot answer this calendar exactly; a session detail read can. */
  | { state: "exact"; fresh?: boolean };

/** SQLite freshness without transcript statistics: last mutation and rewrite generation. */
type SqliteFreshness = {
  kind: "sqlite-mutation";
  sourcePath: string;
  mtimeMs: number;
  generation: string | null;
};
type InstanceSource = UsageCostTranscriptFile | SqliteFreshness;

/** Fold quarter rows for the Usage overview (per family) or `usage.cost` (per day). */
export async function projectUsageCostQuartersInWorker(params: {
  operation: QuarterOperation;
  access: UsageCostCollectionAccess;
  inventory: () => Promise<UsageCostTranscriptFile[]>;
  readFreshness: (
    markers: readonly SqliteSessionFileMarker[],
  ) => Promise<Array<{ mtimeMs: number; generation: string | null } | undefined>>;
  /** Read the cache database; transient failures yield `empty()`. */
  readCache: <T>(read: (db: EngineConnection) => T, empty: () => T) => Promise<T>;
  /** Transcript replay inputs for sub-quarter `usage.cost` ranges. */
  scan: Parameters<typeof readUsageCostReportEntry>[0]["scan"];
  throwIfCancelled: () => void;
}): Promise<UsageCostWorkerResult> {
  const readSnapshot = (filePaths: string[], includeBodies: boolean) =>
    params.readCache(
      (db) =>
        runSqliteReadSnapshotSync(db, () =>
          readUsageCostQuarterSnapshotInDatabase(db, {
            filePaths,
            startMs: params.operation.startMs,
            endMs: params.operation.endMs,
            pricingFingerprint: params.operation.pricingFingerprint,
            includeBodies,
            throwIfCancelled: params.throwIfCancelled,
          }),
        ),
      () => new Map<string, UsageCostQuarterSnapshotEntry>(),
    );
  const { operation, access } = params;
  const range = createUsageQuarterRange({
    startMs: operation.startMs,
    endMs: operation.endMs,
    calendar: createUsageCalendar(operation.dayBucket),
  });
  const invalidRows = new Map<string, SessionCostUsageRollupRow>();
  const counts = {
    /** Instances folded into the report. */
    cached: 0,
    /** Instances missing or older than their transcript; folded ones still count. */
    stale: 0,
    /** Instances omitted without a refresh: exact details or replay allowance needed. */
    deferred: 0,
    /** Deferred instances that need a session detail read for exact usage. */
    boundary: 0,
    /** Instances without quarter rows yet (refresh or upgrade backfill pending). */
    pending: 0,
    refreshedAt: 0,
  };

  function evaluateInstance(instanceParams: {
    path: string | undefined;
    file: InstanceSource | undefined;
    entry: UsageCostQuarterSnapshotEntry | undefined;
  }): InstanceState {
    const { path, file, entry } = instanceParams;
    const envelope = entry?.envelope;
    if (path === undefined || !entry || !envelope?.projection || !file) {
      return { state: "pending" };
    }
    if (entry.row.bodyBytes !== envelope.body.storedBytes) {
      invalidRows.set(entry.row.key, entry.row);
      return { state: "pending" };
    }
    const checkpoint = envelope.checkpoint;
    let fresh: boolean;
    if (file.kind === "sqlite-mutation") {
      if (checkpoint.kind !== "sqlite" || (checkpoint.generation ?? null) !== file.generation) {
        // Discovery and the cache crossed a rewrite; the refresh owner rebuilds it.
        return { state: "pending" };
      }
      // Transcript writes advance the mutation time; a later append keeps the prefix usable.
      fresh = checkpoint.mtimeMs >= file.mtimeMs;
    } else if (
      operation.kind === "overview" &&
      checkpoint.kind === "sqlite" &&
      file.kind === "sqlite"
    ) {
      if ((checkpoint.generation ?? null) !== (file.generation ?? null)) {
        // Discovery and the cache crossed a rewrite; the refresh owner rebuilds it.
        return { state: "pending" };
      }
      // A same-generation append can commit after discovery; newer cache stays usable.
      fresh =
        checkpoint.maxSeq > (file.maxSeq ?? 0) || isUsageCostRollupFresh({ checkpoint, file });
    } else {
      // usage.cost rejects a checkpoint beyond the current transcript, such as a shorter rewrite.
      if (!canUseUsageCostRollupForPartial({ checkpoint, file })) {
        return { state: "pending" };
      }
      fresh = isUsageCostRollupFresh({ checkpoint, file });
    }
    if (entry.missingMonths > 0) {
      return { state: "pending" };
    }
    const blocks: UsageCostQuarterBlock[] = [];
    for (const month of entry.months) {
      const block = decodeUsageCostQuarters(month.date, month.valueJson, month.blob);
      if (!block) {
        invalidRows.set(entry.row.key, entry.row);
        return { state: "pending" };
      }
      if (usageQuartersNeedTranscript(block, range)) {
        return { state: "exact", fresh };
      }
      blocks.push(block);
    }
    let untimestamped: Extract<InstanceState, { state: "covered" }>["untimestamped"];
    if (operation.kind === "overview" && operation.includeUntimestamped) {
      const decoded = decodeUsageCostRollup(
        entry.row.valueJson,
        operation.pricingFingerprint,
        entry.body ?? null,
      );
      if (!decoded) {
        invalidRows.set(entry.row.key, entry.row);
        return { state: "pending" };
      }
      untimestamped = decoded.rollup.untimestamped;
    }
    return { state: "covered", blocks, untimestamped, computedAt: envelope.scannedAt, fresh };
  }

  function cacheStatusOf(): UsageCacheStatus {
    return {
      status:
        counts.stale === 0 && counts.deferred === 0
          ? "fresh"
          : counts.cached > 0 || counts.deferred > 0
            ? "partial"
            : "stale",
      cachedFiles: counts.cached,
      pendingFiles: counts.stale + counts.deferred,
      staleFiles: counts.stale,
      refreshedAt: counts.refreshedAt || undefined,
      ...(counts.boundary > 0
        ? {
            partial: {
              reason: "aggregate-boundary" as const,
              message: USAGE_AGGREGATE_BOUNDARY_MESSAGE,
            },
          }
        : {}),
    };
  }
  const observe = (snapshot: Map<string, UsageCostQuarterSnapshotEntry>) => {
    for (const entry of snapshot.values()) {
      counts.refreshedAt = Math.max(counts.refreshedAt, entry.envelope?.scannedAt ?? 0);
    }
  };

  if (operation.kind === "summary") {
    const files = await params.inventory();
    const snapshot = await readSnapshot(
      files.map((file) => file.filePath),
      true,
    );
    // Sub-quarter ranges replay transcripts within one bounded allowance.
    const replayBudget = { remainingBytes: 16 * 1024 * 1024, deadline: performance.now() + 5_000 };
    const replay = (entry: UsageCostQuarterSnapshotEntry, file: UsageCostTranscriptFile) =>
      readUsageCostReportEntry({
        prepared: {
          valueJson: entry.row.valueJson,
          blob: entry.body ?? null,
          envelope: entry.envelope,
          selected: undefined,
        },
        file,
        startMs: operation.startMs,
        endMs: operation.endMs,
        dayBucket: operation.dayBucket,
        scan: params.scan,
        throwIfCancelled: params.throwIfCancelled,
        replayBudget,
        cacheBudget: { remainingBytes: Number.POSITIVE_INFINITY },
      });
    const formatDay = createUsageDayKeyFormatter(operation.dayBucket);
    observe(snapshot);
    const daily = new Map<string, CostUsageTotals>();
    const totals = createEmptyCostUsageTotals();
    const staleSessionFiles = new Set<string>();
    // Keep file order and per-quarter additions so repeated reports add identically.
    for (const file of files) {
      params.throwIfCancelled();
      const instance = evaluateInstance({
        path: file.filePath,
        file,
        entry: snapshot.get(file.filePath),
      });
      if (instance.state === "pending") {
        counts.stale += 1;
        staleSessionFiles.add(file.sourcePath);
        continue;
      }
      if (instance.state === "exact") {
        const entry = snapshot.get(file.filePath);
        const replayed = entry ? await replay(entry, file) : null;
        if (replayed) {
          counts.cached += 1;
          if (instance.fresh === false) {
            counts.stale += 1;
            staleSessionFiles.add(file.sourcePath);
          }
          addRollupToCostUsageSummary({
            rollup: replayed.rollup,
            startMs: operation.startMs,
            endMs: operation.endMs,
            formatDay,
            daily,
            totals,
          });
        } else if (replayed === null) {
          // The bounded replay allowance is spent; the summary stays partial.
          counts.deferred += 1;
        } else {
          // A failed replay omits the file and asks the refresh owner to rebuild it.
          counts.stale += 1;
          staleSessionFiles.add(file.sourcePath);
          if (entry) {
            invalidRows.set(entry.row.key, entry.row);
          }
        }
        continue;
      }
      counts.cached += 1;
      if (!instance.fresh) {
        counts.stale += 1;
        staleSessionFiles.add(file.sourcePath);
      }
      for (const block of instance.blocks) {
        addUsageQuartersToDailyTotals({ block, range, daily, totals });
      }
    }
    return {
      kind: "summary",
      summary: finishUsageCostSummary({
        daily,
        totals,
        startMs: operation.startMs,
        endMs: operation.endMs,
        formatDay,
        cacheStatus: cacheStatusOf(),
      }),
      staleSessionFiles: [...staleSessionFiles],
      invalidRows: [...invalidRows.values()],
    };
  }

  const families = expandUsageOverviewFamilies(operation);
  const instances = families.flat();
  const paths = await resolveUsageCostTranscriptPaths(
    instances.map((instance) => instance.sessionFile),
    access,
  );
  const snapshot = await readSnapshot(
    [...new Set(paths.filter((path) => path !== undefined))],
    operation.includeUntimestamped === true,
  );
  observe(snapshot);
  // Freshness facts for cached instances: SQLite mutation facts, or file stats for JSONL.
  const files: Array<InstanceSource | undefined> = instances.map(
    (instance) => instance.transcriptFile,
  );
  const sqlite: Array<{ index: number; marker: SqliteSessionFileMarker }> = [];
  const jsonl: number[] = [];
  for (const [index, instance] of instances.entries()) {
    if (instance.transcriptFile || paths[index] === undefined || !snapshot.has(paths[index])) {
      continue;
    }
    const marker = parseSqliteSessionFileMarker(instance.sessionFile);
    if (marker) {
      sqlite.push({ index, marker });
    } else {
      jsonl.push(index);
    }
  }
  const [mutations, stats] = await Promise.all([
    params.readFreshness(sqlite.map(({ marker }) => marker)),
    resolveUsageCostTranscriptFiles(
      jsonl.map((index) => instances[index]!.sessionFile),
      access,
    ),
  ]);
  for (const [position, { index }] of sqlite.entries()) {
    const facts = mutations[position];
    files[index] = facts && {
      kind: "sqlite-mutation",
      sourcePath: instances[index]!.sessionFile,
      ...facts,
    };
  }
  for (const [position, index] of jsonl.entries()) {
    files[index] = stats[position];
  }
  const batch = createUsageOverviewBatchBuilder();
  const computing: boolean[] = [];
  const staleSessionFiles = new Set<string>();
  const fold = createUsageOverviewFold(range);
  let offset = 0;
  for (const family of families) {
    params.throwIfCancelled();
    let covered = 0;
    let incomplete = false;
    family.forEach((instance, position) => {
      const index = offset + position;
      const file = files[index];
      const state = evaluateInstance({
        path: paths[index],
        file,
        entry: paths[index] === undefined ? undefined : snapshot.get(paths[index]),
      });
      if (state.state !== "covered") {
        incomplete = true;
        if (state.state === "exact") {
          counts.deferred += 1;
          counts.boundary += 1;
        } else {
          counts.pending += 1;
          staleSessionFiles.add(file?.sourcePath ?? instance.sessionFile);
        }
        return;
      }
      covered += 1;
      counts.cached += 1;
      if (!state.fresh) {
        staleSessionFiles.add(file?.sourcePath ?? instance.sessionFile);
      }
      fold.addInstance({
        computedAt: state.computedAt,
        ...(state.fresh ? {} : { staleSince: file!.mtimeMs }),
      });
      for (const block of state.blocks) {
        fold.addBlock(block);
      }
      if (state.untimestamped) {
        fold.addUntimestamped(state.untimestamped);
      }
    });
    offset += family.length;
    if (covered > 0) {
      fold.finishInto(batch);
    } else {
      batch.addEmpty();
    }
    computing.push(incomplete);
  }
  counts.stale = staleSessionFiles.size;
  return {
    kind: "overview",
    batch: batch.finish(),
    computing,
    summarizing: counts.pending,
    cacheStatus: cacheStatusOf(),
    staleSessionFiles: [...staleSessionFiles],
    invalidRows: [...invalidRows.values()],
  };
}
