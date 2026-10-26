import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { WorkerTaskError } from "@openclaw/worker-runtime";
import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import type { SqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import { transcriptEventJsonSql } from "../config/sessions/transcript-payload.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { encodeOpenClawStateWorkerError } from "../state/openclaw-state-worker-error.js";
import { iterateSqliteQuerySync } from "./kysely-sync.js";
import {
  readSessionCostUsageRollupRowsInDatabase,
  readSessionCostUsageRollupBodyInDatabase,
  type SessionCostUsageRollupRow,
} from "./session-cost-usage-cache.kernel.js";
import {
  listUsageCountedTranscriptSources,
  resolveUsageCostTranscriptSources,
  resolveUsageCostTranscriptFiles,
  resolveUsageCostTranscriptPaths,
} from "./session-cost-usage-collection.js";
import {
  decodeUsageCostPartition,
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
  decodeUsageCostRollup,
  decodeUsageCostRollupEnvelope,
  isUsageCostRollupFresh,
  USAGE_COST_ROLLUP_VERSION,
  type UsageCostRollupEntry,
} from "./session-cost-usage-rollup-codec.js";
import { projectUsageCostQuartersInWorker } from "./session-cost-usage-worker-overview.js";
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
    control,
    target,
    readStore,
  });
  if (operation.kind === "inventory") {
    const selected = operation.sessionFiles;
    if (!selected && operation.statistics === false) {
      const files = await listUsageCountedTranscriptSources(location.agentId, {
        ...access,
        storePath: location.storePath,
        minMtimeMs: operation.minMtimeMs,
        statistics: false,
      });
      return {
        kind: "inventory",
        files: files.map(({ kind, sourcePath, sessionId, mtimeMs }) => ({
          kind,
          sourcePath,
          sessionId,
          mtimeMs,
        })),
      };
    }
    const files = selected
      ? (await resolveUsageCostTranscriptSources(selected, access)).filter(
          (file) => file !== undefined,
        )
      : await listUsageCountedTranscriptSources(location.agentId, {
          ...access,
          storePath: location.storePath,
          minMtimeMs: operation.minMtimeMs,
        });
    return {
      kind: "inventory",
      files: files.map((file) => ({
        kind: file.kind,
        sourcePath: file.sourcePath,
        sessionId: file.sessionId,
        mtimeMs: file.mtimeMs,
        transcriptFile: file.kind === "sqlite" ? file : undefined,
      })),
    };
  }

  // Resolve keys before synchronously capturing the report's bounded cache inputs.
  const selectedFiles =
    operation.kind === "refresh" && operation.sessionFiles
      ? await resolveUsageCostTranscriptFiles(operation.sessionFiles, access)
      : [];
  const sessionPaths =
    operation.kind === "sessions"
      ? await resolveUsageCostTranscriptPaths(
          operation.sessions.map((session) => session.sessionFile),
          access,
        )
      : undefined;
  const selectedPaths = sessionPaths
    ? sessionPaths.filter((file) => file !== undefined)
    : operation.kind === "refresh" && operation.sessionFiles
      ? selectedFiles.flatMap((file) => (file ? [file.filePath] : []))
      : undefined;
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
  const readMetadata = async (): Promise<SessionCostUsageRollupRow[]> => {
    const receipt = refreshInputs?.rollupReceipt();
    const cached =
      selectedPaths?.flatMap((filePath) => {
        const value = refreshInputs?.readRollup(filePath, receipt);
        return value ? [value.row] : [];
      }) ?? [];
    const cachedKeys = new Set(cached.map((row) => row.key));
    const missing = selectedPaths?.filter((filePath) => !cachedKeys.has(filePath));
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
  const resolveCosts = createUsageCostWorkerPriceResolver((pairs) => host("pricing", pairs));
  const readGeneration = async (marker: SqliteSessionFileMarker) => {
    const facts = readFacts(marker);
    if (facts?.cold) {
      await host("restore", marker);
      // Restore may replace the projection; rebuild this derived cache from the captured bounds.
      return undefined;
    }
    return facts?.generation;
  };
  const readRows = async (
    marker: SqliteSessionFileMarker,
    afterSeq: number,
    throughSeq: number,
  ): Promise<Array<{ seq: number; event: unknown }>> => {
    if (throughSeq <= afterSeq) {
      return [];
    }
    const database = target(marker.agentId, marker.storePath);
    const stored = await readStore(marker.agentId, marker.storePath, () => {
      const result = withOpenClawAgentDatabaseReadOnly(
        (opened) => {
          const query = getSessionKysely(opened.db)
            .selectFrom("transcript_events")
            .select(["seq", transcriptEventJsonSql(opened.db).as("event_json")])
            .where("session_id", "=", marker.sessionId)
            .where("seq", ">", afterSeq)
            .where("seq", "<=", throughSeq)
            .orderBy("seq", "asc")
            .limit(1_024);
          const page: Array<{ seq: number; event_json: string }> = [];
          let bytes = 0;
          // Stop before parsing: retain at most 8 MiB plus one lookahead event.
          for (const row of iterateSqliteQuerySync(opened.db, query)) {
            const size = Buffer.byteLength(row.event_json);
            if (page.length > 0 && bytes + size > 8 * 1024 * 1024) {
              break;
            }
            page.push(row);
            bytes += size;
          }
          return page;
        },
        { ...database, env },
      );
      return result.found ? result.value : [];
    });
    return stored.map((row) => ({ seq: row.seq, event: JSON.parse(row.event_json) as unknown }));
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
  const byPath = new Map(rows.map((row) => [row.key, row]));

  const requestedFiles = selectedFiles.filter((file) => file !== undefined);
  if (requestedFiles.length !== (operation.sessionFiles?.length ?? 0)) {
    throw new WorkerTaskError("A requested usage transcript is unavailable", "unavailable");
  }
  const files = operation.sessionFiles ? requestedFiles : await inventory(operation.sessionsDir);
  const filesByPath = new Map(files.map((file) => [file.filePath, file]));
  let pruned = false;
  if (!operation.sessionFiles) {
    let batch: UsageCostWorkerHostEffects["prune-rows"]["input"] = [];
    let batchBytes = 0;
    const sendBatch = async () => {
      const transfers = batch.map((row) => row.value.buffer);
      await host("prune-rows", batch, transfers);
      batch = [];
      batchBytes = 0;
    };
    for (const row of rows) {
      if (filesByPath.has(row.key)) {
        continue;
      }
      const value = new TextEncoder().encode(row.valueJson);
      const rowBytes = value.byteLength + 2 * row.key.length;
      // Preserve single-row delivery for oversized metadata without growing other batches.
      if (batch.length > 0 && (batch.length >= 64 || batchBytes + rowBytes > 1024 * 1024)) {
        await sendBatch();
      }
      batch.push({ key: row.key, value, updatedAt: row.updatedAt });
      batchBytes += rowBytes;
      pruned = true;
    }
    if (batch.length > 0) {
      await sendBatch();
      await host("prune", {});
    }
  }
  // Partitions written before quarter rows existed, or by a build without them,
  // derive their report rows from the stored partition instead of a transcript scan.
  const quarterGaps = await readCacheOrEmpty(
    (db) =>
      listUsageCostQuarterGapsInDatabase(
        db,
        operation.sessionFiles ? [...filesByPath.keys()] : undefined,
      ),
    () => new Set<string>(),
  );
  const minMtimeMs = operation.sessionFiles ? undefined : operation.startMs;
  const rebuildByPath = new Map(operation.rebuildRows?.map((row) => [row.key, row]));
  const stale = [];
  for (const file of filesByPath.values()) {
    const old = minMtimeMs !== undefined && file.mtimeMs < minMtimeMs;
    const gap = quarterGaps.has(file.filePath);
    if (old && !gap) {
      continue;
    }
    const row = byPath.get(file.filePath);
    const envelope = row
      ? decodeUsageCostRollupEnvelope(row.valueJson, operation.pricingFingerprint)
      : undefined;
    const invalid = rebuildByPath.get(file.filePath);
    const rebuild =
      row &&
      ((invalid?.valueJson === row.valueJson && invalid.updatedAt === row.updatedAt) ||
        (row.bodyBytes !== undefined && envelope?.body.storedBytes !== row.bodyBytes));
    const outdated =
      rebuild ||
      !envelope?.projection ||
      !isUsageCostRollupFresh({ checkpoint: envelope?.checkpoint, file });
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
      let body: { blob: Uint8Array | null } | undefined;
      if (envelope.projection) {
        const snapshot = await readPartitionedBody(row);
        body = snapshot;
        priorPartitions = snapshot?.partitions ?? [];
        priorQuarterDates = snapshot?.quarterDates ?? priorQuarterDates;
      } else {
        body = await control.runNativeSection(() =>
          readDatabase(cacheDatabase, () =>
            readCache((db) => readSessionCostUsageRollupBodyInDatabase(db, row.key), undefined),
          ),
        );
      }
      previous = body
        ? decodeUsageCostRollup(row.valueJson, operation.pricingFingerprint, body.blob)
        : undefined;
    }
    if (previous && envelope?.projection) {
      if (priorPartitions.length !== envelope.projection.dates.length) {
        previous = undefined;
      } else {
        for (const partition of priorPartitions) {
          const day = decodeUsageCostPartition(partition.valueJson, partition.blob);
          if (!day) {
            previous = undefined;
            break;
          }
          Object.assign(previous.rollup.buckets, day.buckets);
        }
      }
    }
    const entry =
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
  if (stale.length === completedFiles) {
    return { kind: "refresh", changed };
  }
  const remaining = stale.slice(completedFiles).map(({ file }) => file);
  const remainingPaths = new Set(remaining.map((file) => file.filePath));
  return {
    kind: "refresh",
    changed,
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
