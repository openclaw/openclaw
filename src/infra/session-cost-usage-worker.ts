import {
  collectErrorGraphCandidates,
  toErrorObject,
} from "@openclaw/normalization-core/error-coercion";
import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import { materializeSessionArchiveForRead } from "../config/sessions/archive-compression.js";
import type { SqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { SessionTranscriptStats } from "../config/sessions/session-accessor.sqlite-contract.js";
import { readTranscriptStatsBatchReadOnlySync } from "../config/sessions/session-accessor.sqlite-read.js";
import {
  getSessionKysely,
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { readHotSessionTranscriptSnapshot } from "../config/sessions/session-cold-storage-read.js";
import { SessionTranscriptColdError } from "../config/sessions/session-cold-storage-state.js";
import { listSessionTranscriptInstances } from "../config/sessions/session-history.js";
import { transcriptEventJsonSql } from "../config/sessions/transcript-payload.js";
import { buildUsageOverview } from "../shared/usage-overview.js";
import {
  openOpenClawAgentDatabaseReadOnly,
  withOpenClawAgentDatabaseReadOnly,
} from "../state/openclaw-agent-db-readonly.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { encodeOpenClawStateWorkerError } from "../state/openclaw-state-worker-error.js";
import { iterateSqliteQuerySync } from "./kysely-sync.js";
import {
  readSessionCostUsageRollupRowsInDatabase,
  readSessionCostUsageRollupBodyInDatabase,
  type SessionCostUsageRollupRow,
} from "./session-cost-usage-cache.kernel.js";
import {
  listUsageCountedTranscriptSources,
  listUsageCountedTranscriptStats,
  resolveUsageCostTranscriptSources,
  resolveUsageCostTranscriptFiles,
  type UsageCostCollectionAccess,
} from "./session-cost-usage-collection.js";
import {
  decodeUsageCostPartition,
  partitionUsageCostRollup,
  type UsageCostPartition,
} from "./session-cost-usage-partitions.js";
import { readSessionCostUsagePartitionsInDatabase } from "./session-cost-usage-partitions.worker.js";
import {
  projectCostUsageSummary,
  projectSessionCostSummaries,
} from "./session-cost-usage-projection.js";
import {
  canUseUsageCostRollupForPartial,
  decodeUsageCostRollup,
  decodeUsageCostRollupEnvelope,
  isUsageCostRollupFresh,
  USAGE_COST_ROLLUP_VERSION,
  type UsageCostRollupEntry,
} from "./session-cost-usage-rollup-codec.js";
import {
  createUsageCostWorkerPriceResolver,
  scanUsageCostRollupInWorker,
} from "./session-cost-usage-worker-refresh.js";
import { readUsageCostReportEntry } from "./session-cost-usage-worker-report.js";
import type {
  UsageCostWorkerDatabase,
  UsageCostWorkerHostEffects,
  UsageCostWorkerHostReply,
  UsageCostWorkerInput,
  UsageCostWorkerReply,
  UsageCostWorkerResult,
} from "./session-cost-usage-worker.types.js";
import { isTransientSqliteError } from "./unhandled-rejections.js";
import { WorkerTaskError } from "./worker-task-pool.js";
import type { WorkerTaskChannel } from "./worker-task-server.js";

class UsageCostHostEffectError extends Error {
  constructor(
    readonly origin: number,
    message: string,
  ) {
    super(message);
    this.name = "UsageCostHostEffectError";
  }
}

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
    // SAFETY: The paired host constructs this reply on the operation's private channel.
    const reply = response.input as UsageCostWorkerHostReply;
    response.consumed();
    if (!reply.ok) {
      throw new UsageCostHostEffectError(reply.origin, reply.message);
    }
    control.throwIfCancelled();
    // SAFETY: Channel request IDs pair this value with the host dispatch for the requested kind.
    return reply.value as UsageCostWorkerHostEffects[Kind]["output"];
  };
  const target = (agentId: string, storePath: string) => {
    const options = toDatabaseOptions(resolveSqliteReadScope({ agentId, storePath, env }));
    const owned = input.databases.find(
      (entry) => entry.agentId === options.agentId && entry.path === options.path,
    );
    if (!owned) {
      throw new Error("Usage worker requested an unowned database");
    }
    return owned;
  };
  const readStore = <T>(agentId: string, storePath: string, read: () => T) => {
    const database = target(agentId, storePath);
    if (isIncognitoOpenClawAgentSqlitePath(database.path, { agentId: database.agentId, env })) {
      throw new Error("Memory transcript reads require the host owner");
    }
    return control.runNativeSection(() => readDatabase(database, read));
  };
  const access: UsageCostCollectionAccess = {
    env,
    materializeArchive: (sourcePath) =>
      control.runNativeSection(() => materializeSessionArchiveForRead(sourcePath)),
    readSqliteMetadata: (storePath, read) => readStore(location.agentId, storePath, read),
    listSqliteInstances: async (agentId, storePath) => {
      const database = target(agentId, storePath);
      return isIncognitoOpenClawAgentSqlitePath(database.path, { agentId: database.agentId, env })
        ? host("memory-instances", { agentId, storePath })
        : readStore(agentId, storePath, () =>
            listSessionTranscriptInstances({ agentId, storePath, env, projection: "list" }),
          );
    },
    readSqliteStats: async (markers) => {
      const result: Array<SessionTranscriptStats | undefined> = Array(markers.length);
      const groups = new Map<string, Array<{ marker: SqliteSessionFileMarker; index: number }>>();
      for (const [index, marker] of markers.entries()) {
        const database = target(marker.agentId, marker.storePath);
        const key = JSON.stringify(database);
        const group = groups.get(key) ?? [];
        group.push({ marker, index });
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        const marker = group[0]!.marker;
        const database = target(marker.agentId, marker.storePath);
        const stats = isIncognitoOpenClawAgentSqlitePath(database.path, {
          agentId: database.agentId,
          env,
        })
          ? await host(
              "memory-stats",
              group.map((item) => item.marker),
            )
          : await readStore(marker.agentId, marker.storePath, () =>
              readTranscriptStatsBatchReadOnlySync(group.map((item) => ({ ...item.marker, env }))),
            );
        for (const [index, item] of group.entries()) {
          result[item.index] = stats[index] ?? undefined;
        }
      }
      return result;
    },
  };
  const inventory = async (sessionsDir?: string) =>
    input.transcriptFiles
      ? (await resolveUsageCostTranscriptFiles(input.transcriptFiles, access)).filter(
          (file) => file !== undefined,
        )
      : listUsageCountedTranscriptStats(location.agentId, {
          ...access,
          storePath: location.storePath,
          sessionsDir,
        });
  if (operation.kind === "inventory") {
    const selected = operation.sessionFiles ?? input.transcriptFiles;
    let files = selected
      ? (await resolveUsageCostTranscriptSources(selected, access)).filter(
          (file) => file !== undefined,
        )
      : await listUsageCountedTranscriptSources(location.agentId, {
          ...access,
          storePath: location.storePath,
          minMtimeMs: operation.minMtimeMs,
        });
    if (
      input.transcriptFiles &&
      operation.sessionFiles === undefined &&
      operation.minMtimeMs !== undefined
    ) {
      const minMtimeMs = operation.minMtimeMs;
      files = files.filter((file) => !(file.mtimeMs < minMtimeMs));
    }
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

  // Resolve keys before reading metadata; report bodies stay in their read snapshot.
  const requestedPaths =
    operation.kind === "sessions"
      ? operation.sessions.map((session) => session.sessionFile)
      : operation.kind === "refresh"
        ? operation.sessionFiles
        : undefined;
  const selectedFiles = requestedPaths
    ? await resolveUsageCostTranscriptFiles(requestedPaths, access)
    : [];
  const selectedPaths = requestedPaths
    ? selectedFiles.flatMap((file) => (file ? [file.filePath] : []))
    : undefined;
  const memoryCache = isIncognitoOpenClawAgentSqlitePath(location.databasePath, {
    agentId: location.agentId,
    env,
  });
  const cacheDatabase = input.databases.find(
    (entry) => entry.path === location.databasePath && entry.agentId === location.agentId,
  );
  if (!cacheDatabase) {
    throw new Error("Usage cache database is not owned by this worker operation");
  }
  const readMetadata = async (): Promise<SessionCostUsageRollupRow[]> => {
    if (memoryCache) {
      const bytes = await host("memory-cache", { filePaths: selectedPaths });
      return bytes.map((row) => ({
        key: row.key,
        updatedAt: row.updatedAt,
        valueJson: Buffer.from(
          row.valueJson.buffer,
          row.valueJson.byteOffset,
          row.valueJson.byteLength,
        ).toString("utf8"),
      }));
    }
    return control.runNativeSection(() =>
      readDatabase(cacheDatabase, () => {
        try {
          const result = withOpenClawAgentDatabaseReadOnly(
            (opened) => readSessionCostUsageRollupRowsInDatabase(opened.db, selectedPaths),
            { ...cacheDatabase, env },
          );
          return result.found ? result.value : [];
        } catch (error) {
          if (!isTransientSqliteError(error)) {
            throw error;
          }
          return [];
        }
      }),
    );
  };
  const readBody = (row: SessionCostUsageRollupRow) =>
    memoryCache
      ? host("memory-cache-body", row)
      : control.runNativeSection(() =>
          readDatabase(cacheDatabase, () => {
            const result = withOpenClawAgentDatabaseReadOnly(
              (opened) => readSessionCostUsageRollupBodyInDatabase(opened.db, row),
              { ...cacheDatabase, env },
            );
            return result.found ? result.value : undefined;
          }),
        );
  const readPartitions = (filePath: string, startMs?: number, endMs?: number) =>
    control.runNativeSection(() =>
      readDatabase(cacheDatabase, () => {
        const result = withOpenClawAgentDatabaseReadOnly(
          (opened) => readSessionCostUsagePartitionsInDatabase(opened.db, filePath, startMs, endMs),
          { ...cacheDatabase, env },
        );
        return result.found ? result.value : [];
      }),
    );
  const resolveCosts = createUsageCostWorkerPriceResolver((pairs) => host("pricing", pairs));
  let readId = 0;
  const readRows = async (
    marker: SqliteSessionFileMarker,
    afterSeq: number,
    throughSeq: number,
  ): Promise<Array<{ seq: number; event: unknown }>> => {
    if (throughSeq <= afterSeq) {
      return [];
    }
    const database = target(marker.agentId, marker.storePath);
    if (isIncognitoOpenClawAgentSqlitePath(database.path, { agentId: database.agentId, env })) {
      const request = { marker, afterSeq, throughSeq, readId: ++readId };
      const events: Array<{ seq: number; event: unknown }> = [];
      let chunks: Uint8Array[] = [];
      for (;;) {
        const frame = await host("memory-transcript", request);
        if (frame.type === "source-unavailable") {
          throw new Error("Usage memory transcript changed while scanning");
        }
        if (frame.type === "source-end") {
          return events;
        }
        chunks.push(frame.bytes);
        if (frame.final) {
          events.push({
            seq: frame.seq,
            event: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
          chunks = [];
        }
      }
    }
    const read = async () => {
      const stored = await readStore(marker.agentId, marker.storePath, () => {
        const result = withOpenClawAgentDatabaseReadOnly(
          (opened) =>
            readHotSessionTranscriptSnapshot(opened, marker.sessionId, "incremental", () => {
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
            }),
          { ...database, env },
        );
        return result.found ? result.value : [];
      });
      return stored.map((row) => ({ seq: row.seq, event: JSON.parse(row.event_json) as unknown }));
    };
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof SessionTranscriptColdError) || error.sessionId !== marker.sessionId) {
        throw error;
      }
      await host("restore", marker);
      return read();
    }
  };
  if (operation.kind === "summary" || operation.kind === "sessions") {
    const project = async (
      rows: SessionCostUsageRollupRow[],
      body: (row: SessionCostUsageRollupRow) => Uint8Array | null | Promise<Uint8Array | null>,
      partitions: (
        filePath: string,
        startMs?: number,
        endMs?: number,
      ) => UsageCostPartition[] | Promise<UsageCostPartition[]> = readPartitions,
    ): Promise<UsageCostWorkerResult> => {
      // Capture cache metadata before transcript stats: a concurrent refresh must
      // not make a valid newer checkpoint appear ahead of this report's inventory.
      const reportFiles =
        operation.kind === "summary"
          ? await inventory()
          : await resolveUsageCostTranscriptFiles(
              operation.sessions.map((session) => session.sessionFile),
              access,
            );
      const byPath = new Map(rows.map((row) => [row.key, row]));
      const filesByPath = new Map(
        reportFiles.flatMap((file) => (file ? [[file.filePath, file] as const] : [])),
      );
      const consumed = new Set<string>();
      const invalidRows = new Map<string, SessionCostUsageRollupRow>();
      const source = {
        readRow(filePath: string) {
          consumed.add(filePath);
          return byPath.get(filePath);
        },
        readBody: body,
        readEntry: (row: SessionCostUsageRollupRow) =>
          readUsageCostReportEntry({
            row,
            file: filesByPath.get(row.key),
            body,
            partitions,
            startMs: operation.startMs,
            endMs: operation.endMs,
            dayBucket: operation.dayBucket,
            overview:
              operation.kind === "sessions" && operation.projection === "overview" && !memoryCache,
            scan: {
              pricingFingerprint: operation.pricingFingerprint,
              resolveCosts,
              readRows,
              access,
            },
          }),
        onInvalidBody(key: string) {
          const row = byPath.get(key);
          if (row) {
            invalidRows.set(key, row);
          }
        },
        remainingRows: (function* () {
          for (const row of rows) {
            if (!consumed.has(row.key)) {
              yield row;
            }
          }
        })(),
      };
      const result =
        operation.kind === "summary"
          ? {
              kind: "summary" as const,
              summary: await projectCostUsageSummary({
                ...source,
                ...operation,
                files: reportFiles.filter((file) => file !== undefined),
              }),
            }
          : {
              kind: "sessions" as const,
              ...(await projectSessionCostSummaries({
                ...source,
                ...operation,
                files: reportFiles,
              })),
            };
      control.throwIfCancelled();
      if (result.kind === "sessions" && operation.kind === "sessions" && operation.overview) {
        return {
          kind: "overview",
          result: buildUsageOverview({
            ...operation.overview,
            summaries: result.summaries,
            dayBucket: operation.dayBucket,
          }),
          cacheStatus: result.cacheStatus,
          staleSessionFiles: result.staleSessionFiles,
          invalidRows: [...invalidRows.values()],
        };
      }
      return { ...result, invalidRows: [...invalidRows.values()] };
    };
    if (!memoryCache) {
      try {
        return await control.runNativeSection(async () => {
          const opened = openOpenClawAgentDatabaseReadOnly({ ...cacheDatabase, env });
          if (!opened.found) {
            return project([], () => null);
          }
          const { db } = opened.database;
          try {
            // sqlite-allow-raw: This dedicated read-only handle owns the complete report snapshot.
            db.exec("BEGIN DEFERRED");
            return await project(
              readSessionCostUsageRollupRowsInDatabase(db, selectedPaths),
              (row) => {
                const body = readSessionCostUsageRollupBodyInDatabase(db, row);
                if (!body) {
                  throw new WorkerTaskError("Usage cache snapshot is unavailable", "unavailable");
                }
                return body.blob;
              },
              (filePath, startMs, endMs) =>
                readSessionCostUsagePartitionsInDatabase(db, filePath, startMs, endMs),
            );
          } finally {
            try {
              if (db.isTransaction) {
                // sqlite-allow-raw: End this report's read-only snapshot before closing its handle.
                db.exec("ROLLBACK");
              }
            } finally {
              opened.database.close();
            }
          }
        });
      } catch (error) {
        if (!isTransientSqliteError(error)) {
          throw error;
        }
        return project([], () => null);
      }
    }
    // Incognito uses its live host writer; validate the complete metadata snapshot
    // after streamed body reads instead of retaining a transaction across host awaits.
    const changed = new Error("usage cache snapshot changed");
    for (let attempt = 0; attempt < 3; attempt++) {
      const rows = await readMetadata();
      try {
        const result = await project(rows, async (row) => {
          const body = await readBody(row);
          if (!body) {
            throw changed;
          }
          return body.blob;
        });
        const current = new Map((await readMetadata()).map((row) => [row.key, row]));
        if (
          current.size === rows.length &&
          rows.every((row) => {
            const next = current.get(row.key);
            return next?.valueJson === row.valueJson && next.updatedAt === row.updatedAt;
          })
        ) {
          control.throwIfCancelled();
          return result;
        }
      } catch (error) {
        if (error !== changed) {
          throw error;
        }
      }
    }
    throw new WorkerTaskError("Usage cache changed while reading; retry the report", "unavailable");
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
  for (const row of rows) {
    if (filesByPath.has(row.key)) {
      continue;
    }
    pruned = true;
    const bytes = new TextEncoder().encode(row.valueJson);
    await host("prune-row", { key: row.key, value: bytes, updatedAt: row.updatedAt }, [
      bytes.buffer,
    ]);
  }
  await host("prune", {});
  const minMtimeMs = operation.sessionFiles ? undefined : operation.startMs;
  const rebuildByPath = new Map(operation.rebuildRows?.map((row) => [row.key, row]));
  const stale = [];
  for (const file of filesByPath.values()) {
    if (minMtimeMs !== undefined && file.mtimeMs < minMtimeMs) {
      continue;
    }
    const row = byPath.get(file.filePath);
    const envelope = row
      ? decodeUsageCostRollupEnvelope(row.valueJson, operation.pricingFingerprint)
      : undefined;
    const invalid = rebuildByPath.get(file.filePath);
    const rebuild =
      row && invalid?.valueJson === row.valueJson && invalid.updatedAt === row.updatedAt;
    if (
      rebuild ||
      (!memoryCache && !envelope?.projection) ||
      !isUsageCostRollupFresh({ checkpoint: envelope?.checkpoint, file })
    ) {
      stale.push({ file, row, envelope, rebuild });
    }
  }
  stale.sort((a, b) => a.file.size - b.file.size || a.file.filePath.localeCompare(b.file.filePath));
  const maxFiles =
    operation.maxFiles !== undefined &&
    Number.isFinite(operation.maxFiles) &&
    operation.maxFiles > 0
      ? Math.floor(operation.maxFiles)
      : undefined;
  let changed = pruned;
  for (const { file, row, envelope, rebuild } of stale.slice(0, maxFiles)) {
    control.throwIfCancelled();
    await host("refresh-session", { sessionFile: file.filePath });
    let previous: UsageCostRollupEntry | undefined;
    if (
      !rebuild &&
      row &&
      envelope &&
      canUseUsageCostRollupForPartial({ checkpoint: envelope.checkpoint, file })
    ) {
      const body = await readBody(row);
      previous = body
        ? decodeUsageCostRollup(row.valueJson, operation.pricingFingerprint, body.blob)
        : undefined;
    }
    const priorPartitions =
      previous && envelope?.projection && !memoryCache ? await readPartitions(file.filePath) : [];
    if (previous && envelope?.projection) {
      if (memoryCache || priorPartitions.length !== envelope.projection.dates.length) {
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
            readRows,
            access,
          });
    const { valueJson, blob, partitions } = partitionUsageCostRollup(
      entry,
      previous !== undefined && envelope?.projection?.canonicalNumbers === true,
      memoryCache,
    );
    const replacePartitions = previous === undefined || !envelope?.projection;
    const previousPartitions = new Map(
      priorPartitions.map((partition) => [partition.date, partition.valueJson]),
    );
    const changedPartitions = partitions.filter(
      (partition) =>
        replacePartitions || previousPartitions.get(partition.date) !== partition.valueJson,
    );
    const dates = new Set(partitions.map((partition) => partition.date));
    const removedDates = envelope?.projection?.dates.filter((date) => !dates.has(date)) ?? [];
    const value = new TextEncoder().encode(valueJson);
    const previousValue = row ? new TextEncoder().encode(row.valueJson) : null;
    const written = await host(
      "write",
      {
        key: file.filePath,
        previousValue,
        value,
        blob,
        updatedAt: entry.scannedAt,
        ...(!memoryCache
          ? {
              partitions: changedPartitions,
              removedDates,
              replacePartitions,
            }
          : {}),
      },
      [
        value.buffer,
        blob.buffer,
        ...changedPartitions.map((partition) => partition.blob.buffer),
        ...(previousValue ? [previousValue.buffer] : []),
      ],
    );
    if (!written) {
      throw new Error(`usage rollup changed while refreshing: ${file.filePath}`);
    }
    changed = true;
  }
  if (!maxFiles || stale.length <= maxFiles) {
    return { kind: "refresh", changed };
  }
  return {
    kind: "refresh",
    changed,
    remainingFiles: stale.slice(maxFiles).map(({ file }) => ({
      sessionFile: file.sourcePath,
      rollupId: file.filePath,
    })),
  };
}

export function usageCostWorkerFailure(
  error: unknown,
): Extract<UsageCostWorkerReply, { ok: false }> {
  const hostFailure = collectErrorGraphCandidates(error, (entry) =>
    entry instanceof Error
      ? [entry.cause, ...(entry instanceof AggregateError ? entry.errors : [])]
      : [],
  ).find((entry): entry is UsageCostHostEffectError => entry instanceof UsageCostHostEffectError);
  return {
    ok: false,
    error: {
      message: toErrorObject(error, "Usage cost worker failed").message,
      error: encodeOpenClawStateWorkerError(error, { includeOrdinary: true }),
      ...(hostFailure
        ? { hostOrigin: hostFailure.origin, hostFailureOnly: error === hostFailure }
        : {}),
    },
  };
}
