import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { WorkerTaskError } from "@openclaw/worker-runtime";
import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import { isSessionArchiveDecodeError } from "../config/sessions/archive-compression.js";
import {
  formatSqliteSessionFileMarker,
  type SqliteSessionFileMarker,
} from "../config/sessions/legacy-sqlite-marker.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import { iterateSessionColdRecords } from "../config/sessions/session-cold-storage-chunks.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import { transcriptEventJsonSql } from "../config/sessions/transcript-payload.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { encodeOpenClawStateWorkerError } from "../state/openclaw-state-worker-error.js";
import { formatErrorMessage } from "./errors.js";
import { iterateSqliteQuerySync } from "./kysely-sync.js";
import {
  readSessionCostUsageRollupRowsInDatabase,
  readSessionCostUsageRollupBodyInDatabase,
  type SessionCostUsageRollupRow,
} from "./session-cost-usage-cache.kernel.js";
import {
  listUsageCountedTranscriptSources,
  readUsageCostTranscriptSourceStats,
  resolveUsageCostTranscriptFiles,
  resolveUsageCostTranscriptPaths,
  resolveUsageCostTranscriptSourcePath,
} from "./session-cost-usage-collection.js";
import {
  partitionUsageCostRollup,
  type UsageCostPartition,
} from "./session-cost-usage-partitions.js";
import { readSessionCostUsageRollupWithPartitionsInDatabase } from "./session-cost-usage-partitions.worker.js";
import {
  deriveUsageCostQuarterBackfill,
  listUsageCostQuarterGapsInDatabase,
  readUsageCostQuarterDatesInDatabase,
  type UsageCostQuarterBackfillRow,
} from "./session-cost-usage-quarters.worker.js";
import {
  createUsageCostCollectionAccess,
  usageRefreshInputs,
} from "./session-cost-usage-refresh-inputs.worker.js";
import {
  canUseUsageCostRollupForPartial,
  decodeUsageCostRollupEnvelope,
  type UsageCostRollupEnvelope,
  isUsageCostRollupFresh,
  USAGE_COST_ROLLUP_VERSION,
  type UsageCostRollupEntry,
} from "./session-cost-usage-rollup-codec.js";
import { projectUsageCostQuartersInWorker } from "./session-cost-usage-worker-overview.js";
import {
  carryUsageCostRollupToFile,
  collectSupersededArchiveRows,
  isCarriedArchiveCurrent,
  createSupersededArchiveKeyResolver,
  loadUsageCostRollupEntry,
  createUsageCostRollupPruner,
} from "./session-cost-usage-worker-prune.js";
import {
  createUsageCostWorkerPriceResolver,
  scanUsageCostRollupInWorker,
} from "./session-cost-usage-worker-refresh.js";
import { projectUsageCostSessionsInWorker } from "./session-cost-usage-worker-report.js";
import type {
  UsageCostWorkerDatabase,
  UsageCostWorkerHostEffects,
  UsageCostWorkerInput,
  UsageCostWorkerReply,
  UsageCostWorkerResult,
} from "./session-cost-usage-worker.types.js";
import type { EngineConnection } from "./sql-connection.js";
import { runSqliteReadSnapshotSync } from "./sqlite-transaction.js";
import { isTransientSqliteError } from "./unhandled-rejections.js";
import type { WorkerTaskChannel } from "./worker-task-server.js";

type ReadDatabase = <T>(
  database: UsageCostWorkerDatabase,
  read: () => T | Promise<T>,
) => Promise<T>;

export async function executeUsageCostWorker(
  input: UsageCostWorkerInput,
  channel: WorkerTaskChannel,
  control: WorkerTaskControl,
  readDatabase: ReadDatabase,
): Promise<UsageCostWorkerResult> {
  const { location, operation } = input;
  const { env } = location;
  channel.consumeInput();
  const host = async <Kind extends keyof UsageCostWorkerHostEffects>(
    kind: Kind,
    value: UsageCostWorkerHostEffects[Kind]["input"],
    transfer: ArrayBuffer[] = [],
  ): Promise<UsageCostWorkerHostEffects[Kind]["output"]> => {
    control.throwIfCancelled();
    const response = await channel.request({ kind, input: value }, transfer);
    response.consumed();
    control.throwIfCancelled();
    // SAFETY: Channel request IDs pair this value with the host dispatch for the requested kind.
    return response.input as UsageCostWorkerHostEffects[Kind]["output"];
  };
  const target = (agentId: string, storePath: string) => {
    const binding = input.stores.find(
      (entry) => entry.agentId === agentId && entry.storePath === storePath,
    )?.database;
    const owned = input.databases.find(
      (entry) => entry.agentId === binding?.agentId && entry.path === binding.path,
    );
    if (!owned) {
      throw new Error("Usage worker requested an unowned database");
    }
    return owned;
  };
  const readStore = <T>(agentId: string, storePath: string, read: () => T) => {
    const database = target(agentId, storePath);
    return control.runNativeSection(() => readDatabase(database, read));
  };
  const refreshInputs =
    operation.kind === "refresh" ? usageRefreshInputs(location.databasePath) : undefined;
  const { access, readFacts, readFreshness, inventory } = createUsageCostCollectionAccess({
    input,
    target,
    readStore,
    readCheckpoint: (marker) => {
      if (operation.kind !== "refresh") {
        return undefined;
      }
      const database = target(marker.agentId, marker.storePath);
      const checkpoint = byPath.get(
        formatSqliteSessionFileMarker({ ...marker, storePath: database.path }),
      )?.envelope?.checkpoint;
      return checkpoint?.kind === "sqlite" ? checkpoint : undefined;
    },
  });
  if (operation.kind === "inventory") {
    const files = await listUsageCountedTranscriptSources(location.agentId, {
      ...access,
      storePath: location.storePath,
      minMtimeMs: operation.minMtimeMs,
      statistics: false,
    });
    return {
      kind: "inventory",
      files: files.map((file) => ({
        kind: file.kind,
        sourcePath: file.sourcePath,
        sessionId: file.sessionId,
        mtimeMs: file.mtimeMs,
      })),
    };
  }

  // Resolve keys before synchronously capturing the report's bounded cache inputs.
  const sessionPaths =
    operation.kind === "sessions"
      ? await resolveUsageCostTranscriptPaths(
          operation.sessions.map((session) => session.sessionFile),
          access,
        )
      : operation.kind === "refresh" && operation.sessionFiles
        ? await resolveUsageCostTranscriptPaths(operation.sessionFiles, access)
        : undefined;
  const selectedPaths = sessionPaths?.filter((file) => file !== undefined);
  const cacheDatabase = input.databases.find(
    (entry) => entry.path === location.databasePath && entry.agentId === location.agentId,
  );
  if (!cacheDatabase) {
    throw new Error("Usage cache database is not owned by this worker operation");
  }
  const readCache = <T>(read: (db: EngineConnection) => T, missing: T): T => {
    const result = withOpenClawAgentDatabaseReadOnly(({ db }) => read(db), {
      ...cacheDatabase,
      env,
    });
    return result.found ? result.value : missing;
  };
  const readMetadata = async (allRows = false): Promise<SessionCostUsageRollupRow[]> => {
    const paths = allRows ? undefined : selectedPaths;
    const receipt = refreshInputs?.rollupReceipt();
    const cached =
      paths?.flatMap((filePath) => {
        const value = refreshInputs?.readRollup(filePath, receipt);
        return value ? [value.row] : [];
      }) ?? [];
    const cachedKeys = new Set(cached.map((row) => row.key));
    const missing = paths?.filter((filePath) => !cachedKeys.has(filePath));
    if (missing?.length === 0) {
      return cached;
    }
    return control.runNativeSection(() =>
      readDatabase(cacheDatabase, () => {
        try {
          const result = withOpenClawAgentDatabaseReadOnly(
            (opened) => readSessionCostUsageRollupRowsInDatabase(opened.db, missing),
            { ...cacheDatabase, env },
          );
          const rows = result.found ? result.value : [];
          for (const row of rows) {
            refreshInputs?.retainRollup(receipt, { row });
          }
          return [...cached, ...rows];
        } catch (error) {
          if (!isTransientSqliteError(error)) {
            throw error;
          }
          return [];
        }
      }),
    );
  };
  const readPartitionedBody = async (row: SessionCostUsageRollupRow) => {
    const receipt = refreshInputs?.rollupReceipt();
    const cached = refreshInputs?.readRollup(row.key, receipt);
    if (cached?.body) {
      return cached.body;
    }
    const body = await control.runNativeSection(() =>
      readDatabase(cacheDatabase, () =>
        readCache(
          (db) =>
            runSqliteReadSnapshotSync(db, () => {
              const stored = readSessionCostUsageRollupWithPartitionsInDatabase(db, row.key);
              return (
                stored && {
                  ...stored,
                  quarterDates: readUsageCostQuarterDatesInDatabase(db, row.key),
                }
              );
            }),
          undefined,
        ),
      ),
    );
    if (body) {
      refreshInputs?.retainRollup(receipt, { row, body });
    }
    return body;
  };
  const loadRollupEntry = (row: SessionCostUsageRollupRow, envelope: UsageCostRollupEnvelope) =>
    loadUsageCostRollupEntry(row, envelope, {
      pricingFingerprint: operation.pricingFingerprint,
      readPartitionedBody,
      readBody: (key) =>
        control.runNativeSection(() =>
          readDatabase(cacheDatabase, () =>
            readCache((db) => readSessionCostUsageRollupBodyInDatabase(db, key), undefined),
          ),
        ),
    });

  const resolveCosts = createUsageCostWorkerPriceResolver((pairs) => host("pricing", pairs));
  const readGeneration = async (marker: SqliteSessionFileMarker) => readFacts(marker)?.generation;
  const readRows = async (
    marker: SqliteSessionFileMarker,
    afterSeq: number,
    throughSeq: number,
    consume: (seq: number, event: unknown) => void,
  ): Promise<number> => {
    if (throughSeq <= afterSeq) {
      return afterSeq;
    }
    const database = target(marker.agentId, marker.storePath);
    return readStore(marker.agentId, marker.storePath, () => {
      const result = withOpenClawAgentDatabaseReadOnly(
        (opened) => {
          if (readFacts(marker)?.cold) {
            const lastSeq = runSqliteReadSnapshotSync(opened.db, () => {
              const archive = readSessionColdTranscript(opened.db, marker.sessionId);
              if (!archive) {
                return undefined;
              }
              let last = afterSeq;
              // Exhaust every chunk before publishing; the decoder verifies totals at EOF.
              for (const record of iterateSessionColdRecords(opened.db, database.path, archive)) {
                control.throwIfCancelled();
                if (
                  record.kind === "event" &&
                  record.row.seq > afterSeq &&
                  record.row.seq <= throughSeq
                ) {
                  consume(record.row.seq, JSON.parse(record.row.event_json));
                  last = record.row.seq;
                }
              }
              return last;
            });
            if (lastSeq !== undefined) {
              return lastSeq;
            }
          }
          const query = getSessionKysely(opened.db)
            .selectFrom("transcript_events")
            .select(["seq", transcriptEventJsonSql(opened.db).as("event_json")])
            .where("session_id", "=", marker.sessionId)
            .where("seq", ">", afterSeq)
            .where("seq", "<=", throughSeq)
            .orderBy("seq", "asc")
            .limit(1_024);
          let lastSeq = afterSeq;
          let bytes = 0;
          // Bound each hot page; the consumer retains only usage and navigation fields.
          for (const row of iterateSqliteQuerySync(opened.db, query)) {
            const size = Buffer.byteLength(row.event_json);
            if (lastSeq > afterSeq && bytes + size > 8 * 1024 * 1024) {
              break;
            }
            consume(row.seq, JSON.parse(row.event_json));
            lastSeq = row.seq;
            bytes += size;
          }
          return lastSeq;
        },
        { ...database, env },
      );
      return result.found ? result.value : afterSeq;
    });
  };
  // A busy cache reads as not yet summarized; reports stay partial and refreshes retry.
  const readCacheOrEmpty = <T>(read: (db: EngineConnection) => T, empty: () => T): Promise<T> =>
    control.runNativeSection(() =>
      readDatabase(cacheDatabase, () => {
        try {
          return readCache(read, empty());
        } catch (error) {
          if (!isTransientSqliteError(error)) {
            throw error;
          }
          return empty();
        }
      }),
    );
  if (operation.kind === "summary" || operation.kind === "overview") {
    return projectUsageCostQuartersInWorker({
      operation,
      access,
      inventory,
      readFreshness,
      readCache: readCacheOrEmpty,
      scan: {
        pricingFingerprint: operation.pricingFingerprint,
        resolveCosts,
        readGeneration,
        readRows,
      },
      throwIfCancelled: control.throwIfCancelled,
    });
  }
  if (operation.kind === "sessions") {
    return projectUsageCostSessionsInWorker({
      operation,
      sessionPaths: sessionPaths ?? [],
      access,
      readFreshness,
      readCache: readCacheOrEmpty,
      scan: {
        pricingFingerprint: operation.pricingFingerprint,
        resolveCosts,
        readGeneration,
        readRows,
      },
      throwIfCancelled: control.throwIfCancelled,
    });
  }

  const rows = await readMetadata();
  const byPath = new Map(
    rows.map((row) => [
      row.key,
      {
        row,
        envelope: decodeUsageCostRollupEnvelope(row.valueJson, operation.pricingFingerprint),
      },
    ]),
  );
  const selectedFiles = operation.sessionFiles
    ? await resolveUsageCostTranscriptFiles(operation.sessionFiles, access)
    : [];

  const requestedFiles = selectedFiles.filter((file) => file !== undefined);
  if (requestedFiles.length !== (operation.sessionFiles?.length ?? 0)) {
    throw new WorkerTaskError("A requested usage transcript is unavailable", "unavailable");
  }
  const sources = operation.sessionFiles
    ? []
    : await listUsageCountedTranscriptSources(location.agentId, {
        ...access,
        storePath: location.storePath,
        sessionsDir: operation.sessionsDir,
        statistics: false,
      });
  const sourcesByPath = new Map(
    sources.map((source) => [resolveUsageCostTranscriptSourcePath(source), source]),
  );
  // Read upgrade gaps before selecting expensive inputs; old live sources still own cache rows.
  const quarterGaps = await readCacheOrEmpty(
    (db) =>
      listUsageCostQuarterGapsInDatabase(
        db,
        operation.sessionFiles ? requestedFiles.map((file) => file.filePath) : undefined,
      ),
    () => new Set<string>(),
  );
  const minMtimeMs = operation.sessionFiles ? undefined : operation.startMs;
  const selectedSources = [...sourcesByPath].filter(
    ([filePath, source]) =>
      !(minMtimeMs !== undefined && source.mtimeMs < minMtimeMs) || quarterGaps.has(filePath),
  );
  const files = operation.sessionFiles
    ? requestedFiles
    : await readUsageCostTranscriptSourceStats(
        selectedSources.map(([, source]) => source),
        access,
      );
  const filesByPath = new Map(files.map((file) => [file.filePath, file]));
  const livePaths = new Set(sourcesByPath.keys());
  // Selected sources can disappear or change archive identity during expansion.
  // Reconcile before pruning; unexpected read errors have already aborted without writes.
  for (const [filePath] of selectedSources) {
    livePaths.delete(filePath);
  }
  for (const file of files) {
    livePaths.add(file.filePath);
  }
  const supersededArchiveKey = createSupersededArchiveKeyResolver(files);
  const supersededArchiveRows: Array<{ row: SessionCostUsageRollupRow; current: string }> = [];
  const pruner = createUsageCostRollupPruner((batch) =>
    host(
      "prune-rows",
      batch,
      batch.map((row) => row.value.buffer),
    ),
  );
  let pruned = false;
  if (!operation.sessionFiles) {
    for (const row of rows) {
      if (livePaths.has(row.key)) {
        continue;
      }
      const current = supersededArchiveKey(row.key);
      if (current) {
        supersededArchiveRows.push({ row, current });
        continue;
      }
      await pruner.prune(row);
      pruned = true;
    }
    await pruner.flush();
  } else if (
    files.some((file) => file.filePath !== file.sourcePath && !byPath.has(file.filePath))
  ) {
    // A targeted archive with a new identity needs its prior row to carry if decoding fails.
    supersededArchiveRows.push(
      ...collectSupersededArchiveRows(await readMetadata(true), supersededArchiveKey, byPath),
    );
  }
  const rebuildByPath = new Map(operation.rebuildRows?.map((row) => [row.key, row]));
  const unreadable = new Map<string, unknown>();
  // Undecodable archives with no usage to carry keep their superseded rows.
  const retainedArchiveKeys = new Set<string>();
  const stale = [];
  for (const file of filesByPath.values()) {
    const old = minMtimeMs !== undefined && file.mtimeMs < minMtimeMs;
    const gap = quarterGaps.has(file.filePath);
    if (old && !gap) {
      continue;
    }
    const cached = byPath.get(file.filePath);
    const row = cached?.row;
    const envelope = cached?.envelope;
    const invalid = rebuildByPath.get(file.filePath);
    const rebuild =
      row &&
      ((invalid?.valueJson === row.valueJson && invalid.updatedAt === row.updatedAt) ||
        (row.bodyBytes !== undefined && envelope?.body.storedBytes !== row.bodyBytes));
    const checkpoint = envelope?.checkpoint;
    const outdated =
      rebuild ||
      (!isCarriedArchiveCurrent(checkpoint, file) &&
        (!envelope?.projection || !isUsageCostRollupFresh({ checkpoint, file })));
    if (outdated && !old) {
      stale.push({ file, row, envelope, rebuild, backfill: false });
    } else if (!outdated && row && gap) {
      stale.push({ file, row, envelope, rebuild, backfill: true });
    }
  }
  stale.sort((a, b) => a.file.size - b.file.size || a.file.filePath.localeCompare(b.file.filePath));
  const maxFiles =
    operation.maxFiles !== undefined &&
    Number.isFinite(operation.maxFiles) &&
    operation.maxFiles > 0
      ? Math.floor(operation.maxFiles)
      : undefined;
  // Yield between whole-file publications so other agents do not spend their
  // worker timeout queued behind a large batch. One large transcript can exceed this quantum.
  const batchDeadline = maxFiles ? performance.now() + 10_000 : Infinity;
  let completedFiles = 0;
  let changed = pruned;
  let pending: UsageCostWorkerHostEffects["write"]["input"] = [];
  let pendingRollups: Array<Parameters<ReturnType<typeof usageRefreshInputs>["retainRollup"]>[1]> =
    [];
  let pendingTransfers: ArrayBuffer[] = [];
  let pendingBytes = 0;
  let pendingQuarters: UsageCostQuarterBackfillRow[] = [];
  let pendingQuarterBytes = 0;
  let flushAt = performance.now() + 1_000;
  const flush = async () => {
    if (pendingQuarters.length > 0) {
      const written = await host(
        "write-quarters",
        pendingQuarters,
        pendingQuarters.map((row) => row.blob.buffer),
      );
      if (!written) {
        throw new Error("Usage quarter batch was not committed");
      }
      pendingQuarters = [];
      pendingQuarterBytes = 0;
    }
    if (pending.length === 0) {
      return;
    }
    const written = await host("write", pending, pendingTransfers);
    if (!written) {
      throw new Error("Usage rollup batch was not committed");
    }
    const receipt = refreshInputs?.rollupReceipt();
    for (const rollup of pendingRollups) {
      refreshInputs?.retainRollup(receipt, rollup);
    }
    pending = [];
    pendingRollups = [];
    pendingTransfers = [];
    pendingBytes = 0;
    flushAt = performance.now() + 1_000;
  };
  for (const item of stale) {
    const { file, row, envelope, backfill } = item;
    let { rebuild } = item;
    if (completedFiles > 0 && (completedFiles === maxFiles || performance.now() >= batchDeadline)) {
      break;
    }
    control.throwIfCancelled();
    if (backfill && row) {
      const derived = deriveUsageCostQuarterBackfill(row.key, await readPartitionedBody(row));
      if (derived) {
        pendingQuarters.push(...derived);
        pendingQuarterBytes += derived.reduce(
          (bytes, quarter) => bytes + quarter.blob.byteLength,
          0,
        );
        if (pendingQuarterBytes >= 1024 * 1024 || performance.now() >= flushAt) {
          await flush();
        }
        changed ||= derived.length > 0;
        completedFiles++;
        continue;
      }
      // An undecodable partition rebuilds the session from its transcript.
      rebuild = true;
    }
    await host("refresh-session", { sessionFile: file.filePath });
    let previous: UsageCostRollupEntry | undefined;
    let priorPartitions: UsageCostPartition[] = [];
    let priorQuarterDates: ReadonlySet<string> = new Set();
    if (
      !rebuild &&
      row &&
      envelope &&
      canUseUsageCostRollupForPartial({ checkpoint: envelope.checkpoint, file })
    ) {
      ({
        entry: previous,
        priorPartitions,
        priorQuarterDates,
      } = await loadRollupEntry(row, envelope));
    }
    let entry: UsageCostRollupEntry;
    try {
      entry =
        previous &&
        !envelope?.projection &&
        isUsageCostRollupFresh({ checkpoint: previous.checkpoint, file })
          ? { ...previous, version: USAGE_COST_ROLLUP_VERSION }
          : await scanUsageCostRollupInWorker({
              file,
              previous,
              pricingFingerprint: operation.pricingFingerprint,
              resolveCosts,
              readGeneration,
              readRows,
              checkProgress: control.throwIfCancelled,
            });
    } catch (error) {
      // Rescanning bytes that cannot be decoded cannot succeed; the rest of the batch commits.
      if (file.kind !== "jsonl" || !isSessionArchiveDecodeError(error)) {
        throw error;
      }
      unreadable.set(file.sourcePath, error);
      // Reports read only the current identity, so carry the last committed usage
      // to it; the checkpoint matches this file, so the archive is not rescanned
      // until its bytes change again.
      const kept =
        row ?? supersededArchiveRows.find(({ current }) => current === file.filePath)?.row;
      const keptEnvelope =
        kept && decodeUsageCostRollupEnvelope(kept.valueJson, operation.pricingFingerprint);
      const carried = kept && keptEnvelope && (await loadRollupEntry(kept, keptEnvelope)).entry;
      const carriedEntry = carried && carryUsageCostRollupToFile(carried, file);
      if (!carriedEntry) {
        retainedArchiveKeys.add(file.filePath);
        completedFiles++;
        continue;
      }
      entry = carriedEntry;
    }
    const { valueJson, blob, partitions } = partitionUsageCostRollup(entry);
    const replacePartitions = previous === undefined || !envelope?.projection;
    const previousPartitions = new Map(
      priorPartitions.map((partition) => [partition.date, partition.valueJson]),
    );
    // Unchanged months still rewrite when their quarter row is missing or stale.
    const changedPartitions = partitions.filter(
      (partition) =>
        replacePartitions ||
        previousPartitions.get(partition.date) !== partition.valueJson ||
        !priorQuarterDates.has(partition.date),
    );
    const dates = new Set(partitions.map((partition) => partition.date));
    const removedDates = envelope?.projection?.dates.filter((date) => !dates.has(date)) ?? [];
    const value = new TextEncoder().encode(valueJson);
    const retainedBytes =
      2 * valueJson.length +
      blob.byteLength +
      partitions.reduce(
        (bytes, partition) => bytes + 2 * partition.valueJson.length + partition.blob.byteLength,
        0,
      );
    // Retained inputs keep partitions only; their committed quarter rows cover every date.
    const body =
      retainedBytes <= 8 * 1024 * 1024
        ? {
            blob,
            partitions: partitions.map(({ quarters: _quarters, ...partition }) => partition),
            quarterDates: dates,
          }
        : undefined;
    pendingBytes += value.byteLength + retainedBytes;
    pending.push({
      key: file.filePath,
      value,
      blob,
      updatedAt: entry.scannedAt,
      partitions: changedPartitions,
      removedDates,
      replacePartitions,
    });
    pendingRollups.push({
      row: { key: file.filePath, valueJson, updatedAt: entry.scannedAt },
      body,
    });
    pendingTransfers.push(
      value.buffer,
      ...changedPartitions.flatMap((partition) =>
        partition.quarters ? [partition.quarters.blob.buffer] : [],
      ),
    );
    // Retained bodies stay in this worker; channel cloning copies only the
    // changed partitions sent to the host. Oversized bodies transfer ownership.
    if (!body) {
      pendingTransfers.push(
        blob.buffer,
        ...changedPartitions.map((partition) => partition.blob.buffer),
      );
    }
    // Bound retained bytes and writer occupancy; a single transcript may exceed
    // the byte/time limit.
    if (pending.length === 50 || pendingBytes >= 1024 * 1024 || performance.now() >= flushAt) {
      await flush();
    }
    changed = true;
    completedFiles++;
  }
  // Refresh completion (including a yielded batch) promises committed totals.
  await flush();
  const unscanned = new Set(stale.slice(completedFiles).map(({ file }) => file.filePath));
  for (const { row, current } of supersededArchiveRows) {
    if (!retainedArchiveKeys.has(current) && !unscanned.has(current)) {
      await pruner.prune(row);
      changed = true;
    }
  }
  await pruner.flush();
  const unreadableFiles = unreadable.size
    ? {
        unreadableFiles: [...unreadable].map(([sessionFile, error]) => ({
          sessionFile,
          message: formatErrorMessage(error),
        })),
      }
    : {};
  if (stale.length === completedFiles) {
    return { kind: "refresh", changed, ...unreadableFiles };
  }
  const remaining = stale.slice(completedFiles).map(({ file }) => file);
  const remainingPaths = new Set(remaining.map((file) => file.filePath));
  return {
    kind: "refresh",
    changed,
    ...unreadableFiles,
    // Keep every requested alias pending even when scanning deduplicated physical keys.
    remainingFiles: (operation.sessionFiles
      ? requestedFiles.filter((file) => remainingPaths.has(file.filePath))
      : remaining
    ).map((file) => ({
      sessionFile: file.sourcePath,
      rollupId: file.filePath,
    })),
  };
}

export function usageCostWorkerFailure(
  error: unknown,
): Extract<UsageCostWorkerReply, { ok: false }> {
  return {
    ok: false,
    error: {
      message: toErrorObject(error, "Usage cost worker failed").message,
      error: encodeOpenClawStateWorkerError(error, { includeOrdinary: true }),
    },
  };
}
