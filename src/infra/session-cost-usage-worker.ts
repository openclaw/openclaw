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
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { encodeOpenClawStateWorkerError } from "../state/openclaw-state-worker-error.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import {
  readSessionCostUsageRollupRowsInDatabase,
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
  decodeUsageCostRollup,
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

  // Selected reads resolve canonical keys first; aggregate and refresh reads snapshot before inventory.
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
  let rows: SessionCostUsageRollupRow[];
  if (
    isIncognitoOpenClawAgentSqlitePath(location.databasePath, { agentId: location.agentId, env })
  ) {
    const bytes = await host("memory-cache", { filePaths: selectedPaths });
    rows = bytes.map((row) => ({
      key: row.key,
      updatedAt: row.updatedAt,
      valueJson: Buffer.from(
        row.valueJson.buffer,
        row.valueJson.byteOffset,
        row.valueJson.byteLength,
      ).toString("utf8"),
    }));
  } else {
    const database = input.databases.find(
      (entry) => entry.path === location.databasePath && entry.agentId === location.agentId,
    );
    if (!database) {
      throw new Error("Usage cache database is not owned by this worker operation");
    }
    rows = await control.runNativeSection(() =>
      readDatabase(database, () => {
        try {
          const result = withOpenClawAgentDatabaseReadOnly(
            (opened) => readSessionCostUsageRollupRowsInDatabase(opened.db, selectedPaths),
            { ...database, env },
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
  }
  const byPath = new Map(rows.map((row) => [row.key, row]));
  const consumed = new Set<string>();
  const source = {
    readRow(filePath: string) {
      consumed.add(filePath);
      return byPath.get(filePath);
    },
    remainingRows: (function* () {
      for (const row of rows) {
        if (!consumed.has(row.key)) {
          yield row;
        }
      }
    })(),
  };
  if (operation.kind === "summary") {
    const files = await inventory();
    return {
      kind: "summary",
      summary: projectCostUsageSummary({ ...source, ...operation, files, refreshing: false }),
    };
  }
  if (operation.kind === "sessions") {
    return {
      kind: "sessions",
      ...projectSessionCostSummaries({
        ...source,
        ...operation,
        files: selectedFiles,
        refreshing: false,
      }),
    };
  }

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
    const entry = row
      ? decodeUsageCostRollup(row.valueJson, operation.pricingFingerprint)
      : undefined;
    const previous: UsageCostStoredRollup | undefined =
      entry && row ? { entry, valueJson: row.valueJson } : undefined;
    if (!isUsageCostRollupFresh({ stored: previous, file })) {
      stale.push({ file, previous });
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
                .select(["seq", "event_json"])
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
  for (const { file, previous } of stale.slice(0, maxFiles)) {
    control.throwIfCancelled();
    const entry = await scanUsageCostRollupInWorker({
      file,
      previous,
      pricingFingerprint: operation.pricingFingerprint,
      resolveCosts,
      readRows,
      access,
    });
    const value = new TextEncoder().encode(JSON.stringify(entry));
    const rawPrevious = byPath.get(file.filePath)?.valueJson;
    const previousValue = rawPrevious === undefined ? null : new TextEncoder().encode(rawPrevious);
    const written = await host(
      "write",
      { key: file.filePath, previousValue, value, updatedAt: entry.scannedAt },
      [value.buffer, ...(previousValue ? [previousValue.buffer] : [])],
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
