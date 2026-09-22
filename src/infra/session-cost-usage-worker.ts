import type { ModelCostConfig } from "@openclaw/llm-core";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { materializeSessionArchiveForRead } from "../config/sessions/archive-compression.js";
import type { SqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  listSessionTranscriptInstances,
  readTranscriptStatsBatchReadOnlySync,
} from "../config/sessions/session-accessor.js";
import type { SessionTranscriptStats } from "../config/sessions/session-accessor.sqlite-contract.js";
import {
  getSessionKysely,
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { readHotSessionTranscriptSnapshot } from "../config/sessions/session-cold-storage-read.js";
import { SessionTranscriptColdError } from "../config/sessions/session-cold-storage-state.js";
import { transcriptEventJsonSql } from "../config/sessions/transcript-payload.js";
import {
  openOpenClawAgentDatabaseReadOnly,
  withOpenClawAgentDatabaseReadOnly,
} from "../state/openclaw-agent-db-readonly.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { encodeOpenClawStateWorkerError } from "../state/openclaw-state-worker-error.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
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
  decodeUsageCostRollup,
  decodeUsageCostRollupEnvelope,
  encodeUsageCostRollup,
  isUsageCostRollupFresh,
  type UsageCostStoredRollup,
} from "./session-cost-usage-rollup-codec.js";
import { scanUsageCostRollupInWorker } from "./session-cost-usage-worker-refresh.js";
import type {
  UsageCostWorkerDatabase,
  UsageCostWorkerHostEffects,
  UsageCostWorkerHostReply,
  UsageCostWorkerInput,
  UsageCostWorkerReply,
  UsageCostWorkerResult,
} from "./session-cost-usage-worker.types.js";
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
  const inventory = (minMtimeMs?: number, sessionsDir?: string) =>
    listUsageCountedTranscriptStats(location.agentId, {
      ...access,
      storePath: location.storePath,
      sessionsDir,
      minMtimeMs,
    });
  if (operation.kind === "inventory") {
    const files = operation.sessionFiles
      ? (await resolveUsageCostTranscriptSources(operation.sessionFiles, access)).filter(
          (file) => file !== undefined,
        )
      : await listUsageCountedTranscriptSources(location.agentId, {
          ...access,
          storePath: location.storePath,
          minMtimeMs: operation.minMtimeMs,
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
      const reportFiles =
        operation.kind === "summary"
          ? await inventory()
          : await resolveUsageCostTranscriptFiles(
              operation.sessions.map((session) => session.sessionFile),
              access,
            );
      const byPath = new Map(rows.map((row) => [row.key, row]));
      const consumed = new Set<string>();
      const invalidRows = new Map<string, SessionCostUsageRollupRow>();
      const source = {
        readRow(filePath: string) {
          consumed.add(filePath);
          return byPath.get(filePath);
        },
        readBody: body,
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

  const discovered = await inventory(undefined, operation.sessionsDir);
  const requestedFiles = (
    await resolveUsageCostTranscriptFiles(operation.sessionFiles ?? [], access)
  ).filter((file) => file !== undefined);
  const filesByPath = new Map(discovered.map((file) => [file.filePath, file]));
  for (const file of requestedFiles) {
    filesByPath.set(file.filePath, file);
  }
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
  const requestedPaths = new Set(requestedFiles.map((file) => file.filePath));
  const rebuildByPath = new Map(operation.rebuildRows?.map((row) => [row.key, row]));
  const stale = [];
  for (const file of filesByPath.values()) {
    if (
      requestedPaths.size > 0
        ? !requestedPaths.has(file.filePath)
        : operation.startMs !== undefined && file.mtimeMs < operation.startMs
    ) {
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
                .orderBy("seq", "asc");
              return executeSqliteQuerySync(opened.db, query).rows;
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
  for (const { file, row, envelope, rebuild } of stale.slice(0, maxFiles)) {
    control.throwIfCancelled();
    let previous: UsageCostStoredRollup | undefined;
    if (
      !rebuild &&
      row &&
      envelope &&
      canUseUsageCostRollupForPartial({ checkpoint: envelope.checkpoint, file })
    ) {
      const body = await readBody(row);
      const entry = body
        ? decodeUsageCostRollup(row.valueJson, operation.pricingFingerprint, body.blob)
        : undefined;
      if (entry) {
        previous = { entry };
      }
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
  }
  return { kind: "refresh" };
}

export function usageCostWorkerFailure(
  error: unknown,
): Extract<UsageCostWorkerReply, { ok: false }> {
  const pending = [error];
  const seen = new Set<unknown>();
  let hostFailure: UsageCostHostEffectError | undefined;
  for (const entry of pending) {
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    if (entry instanceof UsageCostHostEffectError) {
      hostFailure ??= entry;
    }
    if (entry instanceof Error && entry.cause) {
      pending.push(entry.cause);
    }
    if (entry instanceof AggregateError) {
      pending.push(...entry.errors);
    }
  }
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
