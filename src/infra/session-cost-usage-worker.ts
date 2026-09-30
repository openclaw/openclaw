import fs from "node:fs";
import type { ModelCostConfig } from "@openclaw/llm-core";
import {
  collectErrorGraphCandidates,
  toErrorObject,
} from "@openclaw/normalization-core/error-coercion";
import { materializeSessionArchiveForRead } from "../config/sessions/archive-compression.js";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import type { SqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  listSessionTranscriptInstances,
  readTranscriptStatsBatchReadOnlySync,
} from "../config/sessions/session-accessor.js";
import type { SessionTranscriptStats } from "../config/sessions/session-accessor.sqlite-contract.js";
import {
  readSessionTranscriptEventTimeSourceFromDatabase,
  sessionTranscriptEventTimeSourceOverlapsRange,
  sessionTranscriptEventsOverlapRange,
} from "../config/sessions/session-accessor.sqlite-event-time.js";
import {
  getSessionKysely,
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { resolveSessionColdArchivePath } from "../config/sessions/session-cold-storage-codec.js";
import { readHotSessionTranscriptSnapshot } from "../config/sessions/session-cold-storage-read.js";
import {
  readSessionColdTranscript,
  SessionTranscriptColdError,
  type SessionColdArchive,
} from "../config/sessions/session-cold-storage-state.js";
import type { SessionTranscriptEventTimeRange } from "../config/sessions/transcript-event-time.js";
import { transcriptEventJsonSql } from "../config/sessions/transcript-payload.js";
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
  projectCostUsageSummary,
  projectSessionCostSummaries,
} from "./session-cost-usage-projection.js";
import {
  canUseUsageCostRollupForPartial,
  boundedInventoryEventTimeRange,
  boundedInventoryStartMs,
  cachedRollupMayOverlapEventTimeRange,
  decodeUsageCostRollup,
  decodeUsageCostRollupEnvelope,
  encodeUsageCostRollup,
  isUsageCostRollupFresh,
  type UsageCostRollupEntry,
} from "./session-cost-usage-rollup-codec.js";
import { scanUsageCostRollupInWorker } from "./session-cost-usage-worker-refresh.js";
import type {
  CachedSummaryEventTimeLookup,
  UsageCostWorkerDatabase,
  UsageCostWorkerHostEffects,
  UsageCostWorkerHostReply,
  UsageCostWorkerInput,
  UsageCostWorkerReply,
  UsageCostWorkerResult,
} from "./session-cost-usage-worker.types.js";
import type { UsageCostTranscriptFile } from "./session-cost-usage.types.js";
import { isTransientSqliteError } from "./unhandled-rejections.js";
import type { WorkerTaskControl } from "./worker-task-native-sections.js";
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

// Cache only verified bounded-range exclusions; every hit rechecks live archive identity.
const MAX_VERIFIED_COLD_ARCHIVE_EXCLUSIONS = 256;
const verifiedColdArchiveExclusions = new Map<string, true>();

function boundedEventTimeRangeKey(range: SessionTranscriptEventTimeRange): string | undefined {
  const { startMs, endMs } = range;
  if (
    startMs === undefined ||
    !Number.isFinite(startMs) ||
    endMs === undefined ||
    !Number.isFinite(endMs) ||
    startMs > endMs
  ) {
    return undefined;
  }
  return JSON.stringify([startMs, endMs]);
}

type ColdArchiveIdentity = Pick<
  SessionColdArchive,
  | "session_id"
  | "generation"
  | "archive_name"
  | "archive_sha256"
  | "event_count"
  | "raw_bytes"
  | "archive_bytes"
  | "last_seq"
  | "storage"
>;

function verifiedColdArchiveExclusionKey(params: {
  agentId: string;
  databasePath: string;
  storePath: string;
  sessionId: string;
  range: SessionTranscriptEventTimeRange;
  archive: ColdArchiveIdentity;
}): string | undefined {
  const rangeKey = boundedEventTimeRangeKey(params.range);
  const archive = params.archive;
  if (
    !rangeKey ||
    archive.session_id !== params.sessionId ||
    !archive.generation ||
    !/^[a-f0-9]{64}$/.test(archive.archive_sha256) ||
    !Number.isSafeInteger(archive.archive_bytes) ||
    archive.archive_bytes < 0 ||
    !Number.isSafeInteger(archive.event_count) ||
    !Number.isSafeInteger(archive.raw_bytes) ||
    !Number.isSafeInteger(archive.last_seq)
  ) {
    return undefined;
  }
  try {
    const databaseStat = fs.statSync(params.databasePath, { bigint: true });
    if (!databaseStat.isFile()) {
      return undefined;
    }
    const databaseIdentity = [databaseStat.dev.toString(), databaseStat.ino.toString()];
    let archiveFileIdentity: string[] | undefined;
    if (archive.storage === "file") {
      const archivePath = resolveSessionColdArchivePath(params.storePath, archive.archive_name);
      const archiveStat = fs.statSync(archivePath, { bigint: true });
      if (!archiveStat.isFile() || archiveStat.size !== BigInt(archive.archive_bytes)) {
        return undefined;
      }
      archiveFileIdentity = [
        archiveStat.dev.toString(),
        archiveStat.ino.toString(),
        archiveStat.size.toString(),
        archiveStat.mtimeNs.toString(),
        archiveStat.ctimeNs.toString(),
      ];
    } else if (archive.storage !== "sqlite") {
      return undefined;
    }
    return JSON.stringify([
      "cold-event-time-exclusion-v1",
      params.agentId,
      params.databasePath,
      databaseIdentity,
      params.storePath,
      params.sessionId,
      archive.generation,
      archive.archive_name,
      archive.archive_sha256,
      archive.archive_bytes,
      archive.event_count,
      archive.raw_bytes,
      archive.last_seq,
      archive.storage,
      archiveFileIdentity,
      rangeKey,
    ]);
  } catch {
    return undefined;
  }
}

function hasVerifiedColdArchiveExclusion(key: string): boolean {
  if (!verifiedColdArchiveExclusions.has(key)) {
    return false;
  }
  verifiedColdArchiveExclusions.delete(key);
  verifiedColdArchiveExclusions.set(key, true);
  return true;
}

function rememberVerifiedColdArchiveExclusion(key: string): void {
  verifiedColdArchiveExclusions.delete(key);
  verifiedColdArchiveExclusions.set(key, true);
  if (verifiedColdArchiveExclusions.size > MAX_VERIFIED_COLD_ARCHIVE_EXCLUSIONS) {
    const oldest = verifiedColdArchiveExclusions.keys().next().value;
    if (oldest !== undefined) {
      verifiedColdArchiveExclusions.delete(oldest);
    }
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
  const readStore = <T>(
    agentId: string,
    storePath: string,
    read: () => T | Promise<T>,
  ): Promise<T> => {
    const database = target(agentId, storePath);
    if (isIncognitoOpenClawAgentSqlitePath(database.path, { agentId: database.agentId, env })) {
      throw new Error("Memory transcript reads require the host owner");
    }
    return control.runNativeSection(() => readDatabase(database, read));
  };
  const minMtimeMs = operation.kind === "inventory" ? operation.minMtimeMs : undefined;
  let cachedSummaryEventTimeLookup: CachedSummaryEventTimeLookup | undefined;
  const access: UsageCostCollectionAccess = {
    env,
    materializeArchive: (sourcePath) =>
      control.runNativeSection(() => materializeSessionArchiveForRead(sourcePath)),
    readSqliteMetadata: (storePath, read) => readStore(location.agentId, storePath, read),
    listSqliteInstances: async (agentId, storePath, includeAllWindows) => {
      const database = target(agentId, storePath);
      const instances = await (isIncognitoOpenClawAgentSqlitePath(database.path, {
        agentId: database.agentId,
        env,
      })
        ? host("memory-instances", { agentId, storePath, includeAllWindows })
        : readStore(agentId, storePath, () =>
            listSessionTranscriptInstances(
              { agentId, storePath, env, projection: "list" },
              { includeAllWindows },
            ).filter((instance) => !isInternalSessionEffectsKey(instance.sessionKey)),
          ));
      return minMtimeMs === undefined
        ? instances
        : instances.filter((instance) => instance.updatedAtMs >= minMtimeMs);
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
    preflightSqliteEventTime: async (marker, range, updatedAtMs, file) => {
      const database = target(marker.agentId, marker.storePath);
      if (
        isIncognitoOpenClawAgentSqlitePath(database.path, {
          agentId: database.agentId,
          env,
        })
      ) {
        const cachedDecision = await cachedSummaryEventTimeLookup?.(marker, range, file);
        if (cachedDecision !== undefined) {
          return cachedDecision;
        }
        return host("memory-event-time", { marker, range, updatedAtMs });
      }
      const currentArchive =
        operation.kind === "summary"
          ? await readStore(marker.agentId, marker.storePath, () => {
              const result = withOpenClawAgentDatabaseReadOnly(
                (opened) => readSessionColdTranscript(opened.db, marker.sessionId),
                { ...database, env },
              );
              return result.found ? result.value : undefined;
            })
          : undefined;
      // Only cold archives need the rollup shortcut to avoid scanning archived events.
      // Hot SQLite has event-time rows available and would otherwise parse a fresh rollup
      // here, then parse the same body again while projecting the summary.
      if (currentArchive) {
        const cachedDecision = await cachedSummaryEventTimeLookup?.(marker, range, file);
        if (cachedDecision !== undefined) {
          return cachedDecision;
        }
      }
      if (operation.kind !== "summary" || !boundedEventTimeRangeKey(range)) {
        return readStore(marker.agentId, marker.storePath, () =>
          sessionTranscriptEventsOverlapRange(marker, range, updatedAtMs, env),
        );
      }
      const identity = currentArchive
        ? verifiedColdArchiveExclusionKey({
            agentId: marker.agentId,
            databasePath: database.path,
            storePath: marker.storePath,
            sessionId: marker.sessionId,
            range,
            archive: currentArchive,
          })
        : undefined;
      if (identity && hasVerifiedColdArchiveExclusion(identity)) {
        return false;
      }
      const source = await readStore(marker.agentId, marker.storePath, () => {
        const result = withOpenClawAgentDatabaseReadOnly(
          (opened) =>
            readSessionTranscriptEventTimeSourceFromDatabase(opened, marker, range, updatedAtMs),
          { ...database, env },
        );
        if (!result.found) {
          throw new Error(`Usage transcript database is unavailable for ${marker.sessionId}`);
        }
        return result.value;
      });
      const overlaps = await sessionTranscriptEventTimeSourceOverlapsRange(source, range);
      if (!overlaps && identity && source.kind === "cold") {
        const verifiedIdentity = verifiedColdArchiveExclusionKey({
          agentId: marker.agentId,
          databasePath: database.path,
          storePath: marker.storePath,
          sessionId: marker.sessionId,
          range,
          archive: source.archive,
        });
        if (verifiedIdentity === identity) {
          rememberVerifiedColdArchiveExclusion(identity);
        }
      }
      return overlaps;
    },
  };
  const inventory = (eventTimeRange?: SessionTranscriptEventTimeRange, sessionsDir?: string) =>
    listUsageCountedTranscriptStats(location.agentId, {
      ...access,
      storePath: location.storePath,
      sessionsDir,
      eventTimeRange,
    });
  if (operation.kind === "inventory") {
    const files = operation.sessionFiles
      ? (await resolveUsageCostTranscriptSources(operation.sessionFiles, access)).filter(
          (file) => file !== undefined,
        )
      : await listUsageCountedTranscriptSources(location.agentId, {
          ...access,
          storePath: location.storePath,
          eventTimeRange: operation.eventTimeRange,
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

  // Resolve keys before reading metadata; report bodies stay in their read snapshot.
  const selectedFiles =
    operation.kind === "sessions"
      ? await resolveUsageCostTranscriptFiles(
          operation.sessions.map((session) => session.sessionFile),
          access,
        )
      : [];
  const selectedPaths =
    operation.kind === "sessions"
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
  if (operation.kind === "summary" || operation.kind === "sessions") {
    const project = async (
      rows: SessionCostUsageRollupRow[],
      body: (row: SessionCostUsageRollupRow) => Uint8Array | null | Promise<Uint8Array | null>,
    ): Promise<UsageCostWorkerResult> => {
      // Capture cache metadata before transcript stats: a concurrent refresh must
      // not make a valid newer checkpoint appear ahead of this report's inventory.
      const byPath = new Map(rows.map((row) => [row.key, row]));
      const bodyReads = new Map<string, Promise<Uint8Array | null>>();
      const readCachedBody = (row: SessionCostUsageRollupRow) => {
        let pending = bodyReads.get(row.key);
        if (!pending) {
          pending = Promise.resolve(body(row));
          bodyReads.set(row.key, pending);
        }
        return pending;
      };
      const consumed = new Set<string>();
      const invalidRows = new Map<string, SessionCostUsageRollupRow>();
      if (operation.kind === "summary") {
        cachedSummaryEventTimeLookup = async (marker, range, file) => {
          if (file.kind !== "sqlite" || file.sessionId !== marker.sessionId) {
            return undefined;
          }
          const row = byPath.get(file.filePath);
          const envelope = row
            ? decodeUsageCostRollupEnvelope(row.valueJson, operation.pricingFingerprint)
            : undefined;
          if (
            !row ||
            !envelope ||
            !isUsageCostRollupFresh({ checkpoint: envelope.checkpoint, file })
          ) {
            return undefined;
          }
          const entry = decodeUsageCostRollup(
            row.valueJson,
            operation.pricingFingerprint,
            await readCachedBody(row),
          );
          if (!entry) {
            bodyReads.delete(row.key);
            return undefined;
          }
          // A fresh verified rollup covers every timed contribution used by this summary.
          const decision = cachedRollupMayOverlapEventTimeRange(entry, range);
          if (decision !== true) {
            bodyReads.delete(row.key);
          }
          return decision;
        };
      }
      let reportFiles: Array<UsageCostTranscriptFile | undefined>;
      try {
        reportFiles =
          operation.kind === "summary"
            ? await inventory(boundedInventoryEventTimeRange(operation.startMs, operation.endMs))
            : await resolveUsageCostTranscriptFiles(
                operation.sessions.map((session) => session.sessionFile),
                access,
              );
      } finally {
        cachedSummaryEventTimeLookup = undefined;
      }
      const source = {
        readRow(filePath: string) {
          consumed.add(filePath);
          return byPath.get(filePath);
        },
        async readBody(row: SessionCostUsageRollupRow) {
          const bytes = await readCachedBody(row);
          bodyReads.delete(row.key);
          return bytes;
        },
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
                refreshing: false,
              }),
            }
          : {
              kind: "sessions" as const,
              ...(await projectSessionCostSummaries({
                ...source,
                ...operation,
                files: reportFiles,
                refreshing: false,
              })),
            };
      control.throwIfCancelled();
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

  const inventoryStartMs = boundedInventoryStartMs(operation.startMs);
  const discovered = await inventory(
    boundedInventoryEventTimeRange(operation.startMs, operation.endMs),
    operation.sessionsDir,
  );
  const requestedFiles = (
    await resolveUsageCostTranscriptFiles(operation.sessionFiles ?? [], access)
  ).filter((file) => file !== undefined);
  if (requestedFiles.length !== (operation.sessionFiles?.length ?? 0)) {
    throw new WorkerTaskError("A requested usage transcript is unavailable", "unavailable");
  }
  const filesByPath = new Map(discovered.map((file) => [file.filePath, file]));
  for (const file of requestedFiles) {
    filesByPath.set(file.filePath, file);
  }
  // A bounded inventory cannot decide whether older cache rows still have a source.
  if (inventoryStartMs === undefined) {
    for (const row of rows) {
      if (filesByPath.has(row.key)) {
        continue;
      }
      const bytes = new TextEncoder().encode(row.valueJson);
      await host("prune-row", { key: row.key, value: bytes, updatedAt: row.updatedAt }, [
        bytes.buffer,
      ]);
    }
    await host("prune", {});
  }
  const requestedPaths = new Set(requestedFiles.map((file) => file.filePath));
  const rebuildByPath = new Map(operation.rebuildRows?.map((row) => [row.key, row]));
  const stale = [];
  for (const file of filesByPath.values()) {
    if (requestedPaths.size > 0 && !requestedPaths.has(file.filePath)) {
      continue;
    }
    const row = byPath.get(file.filePath);
    const envelope = row
      ? decodeUsageCostRollupEnvelope(row.valueJson, operation.pricingFingerprint)
      : undefined;
    const invalid = rebuildByPath.get(file.filePath);
    const rebuild =
      row && invalid?.valueJson === row.valueJson && invalid.updatedAt === row.updatedAt;
    if (rebuild || !isUsageCostRollupFresh({ checkpoint: envelope?.checkpoint, file })) {
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
  const prices = new Map<string, ModelCostConfig | undefined>();
  const resolveCosts = async (pairs: Array<{ provider?: string; model?: string }>) => {
    const missing = new Map(
      pairs
        .filter((pair) => !prices.has(JSON.stringify(pair)))
        .map((pair) => [JSON.stringify(pair), pair]),
    );
    if (missing.size > 0) {
      const keys = [...missing.keys()];
      const costs = await host("pricing", [...missing.values()]);
      keys.forEach((key, index) => prices.set(key, costs[index]));
    }
    return pairs.map((pair) => prices.get(JSON.stringify(pair)));
  };
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
  let changed = false;
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
    const entry = await scanUsageCostRollupInWorker({
      file,
      previous,
      pricingFingerprint: operation.pricingFingerprint,
      resolveCosts,
      readRows,
      access,
    });
    const { valueJson, blob } = encodeUsageCostRollup(entry);
    const value = new TextEncoder().encode(valueJson);
    const rawPrevious = byPath.get(file.filePath)?.valueJson;
    const previousValue = rawPrevious === undefined ? null : new TextEncoder().encode(rawPrevious);
    const written = await host(
      "write",
      { key: file.filePath, previousValue, value, blob, updatedAt: entry.scannedAt },
      [value.buffer, blob.buffer, ...(previousValue ? [previousValue.buffer] : [])],
    );
    if (!written) {
      throw new Error(`usage rollup changed while refreshing: ${file.filePath}`);
    }
    changed = true;
  }
  return { kind: "refresh", changed };
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
