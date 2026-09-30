import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { materializeSessionArchiveForRead } from "../config/sessions/archive-compression.js";
import {
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  parseSessionArchiveTimestamp,
  parseUsageCountedSessionIdFromFileName,
} from "../config/sessions/artifacts.js";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
  type SqliteSessionFileMarker,
} from "../config/sessions/legacy-sqlite-marker.js";
import {
  resolveSessionArtifactDirectory,
  resolveSessionFilePathCore,
  resolveSessionTranscriptsDirForAgent,
} from "../config/sessions/paths.js";
import {
  listSessionTranscriptArchivesReadOnly,
  listSessionTranscriptInstances,
  loadSessionEntryReadOnly,
  loadTranscriptEventsSync,
  readTranscriptStatsBatchReadOnlySync,
  readTranscriptStatsSync,
} from "../config/sessions/session-accessor.js";
import {
  MAX_TASK_ARCHIVE_RECORD_BYTES,
  TASK_ARCHIVE_RECORD_CAPACITY_ERROR,
  readTranscriptArchiveRecords,
} from "../config/sessions/session-accessor.sqlite-archive-stream.js";
import type { SessionTranscriptStats } from "../config/sessions/session-accessor.sqlite-contract.js";
import { sessionTranscriptEventsOverlapRange } from "../config/sessions/session-accessor.sqlite-event-time.js";
import {
  listDurableSqliteTargetPathsForSessionStorePath,
  resolveSqliteTargetFromSessionStorePath,
} from "../config/sessions/session-sqlite-target.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import {
  transcriptEventJsonMayOverlapRange,
  transcriptMetadataMayOverlapRange,
  type SessionTranscriptEventTimeRange,
} from "../config/sessions/transcript-event-time.js";
import { streamSessionTranscriptLines } from "../config/sessions/transcript-stream.js";
import { selectVisibleTranscriptEvents } from "../config/sessions/transcript-visible-events.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { resolveRealpathOrAbsolute } from "./boundary-path.js";
import { hasErrnoCode } from "./errno.js";
import type { UsageCostTranscriptFile } from "./session-cost-usage.types.js";

const USAGE_COST_TRANSCRIPT_STAT_CONCURRENCY = 32;
const USAGE_COST_EVENT_TIME_PREFLIGHT_CONCURRENCY = 4;

export type UsageCostCollectionAccess = {
  env?: NodeJS.ProcessEnv;
  materializeArchive?: (sourcePath: string) => Promise<string>;
  readSqliteMetadata?: <T>(storePath: string, read: () => T) => Promise<T>;
  listSqliteInstances?: (
    agentId: string,
    storePath: string,
    includeAllWindows: boolean,
  ) => Promise<Array<{ agentId: string; sessionId: string; updatedAtMs: number }>>;
  readSqliteStats?: (
    markers: readonly SqliteSessionFileMarker[],
  ) => Promise<Array<SessionTranscriptStats | undefined>>;
  preflightSqliteEventTime?: (
    marker: SqliteSessionFileMarker,
    range: SessionTranscriptEventTimeRange,
    updatedAtMs: number | null | undefined,
    file: UsageCostTranscriptFile,
  ) => Promise<boolean | undefined>;
};

type UsageCostJsonlSource = {
  kind: "jsonl";
  sourcePath: string;
  sessionId?: string;
  mtimeMs: number;
  stats: fs.Stats;
};

type UsageCostSqliteFile = UsageCostTranscriptFile & { kind: "sqlite" };
type UsageCostTranscriptSource = UsageCostJsonlSource | UsageCostSqliteFile;

async function materializeUsageCostTranscriptSource(
  source: UsageCostTranscriptSource,
  access?: UsageCostCollectionAccess,
): Promise<UsageCostTranscriptFile> {
  if (source.kind === "sqlite") {
    return source;
  }
  const { sourcePath, stats: sourceStats } = source;
  // Identity and freshness belong to the source; incremental offsets and
  // byte signatures must describe the decompressed file used by readers.
  const filePath = access?.materializeArchive
    ? await access.materializeArchive(sourcePath)
    : materializeSessionArchiveForRead(sourcePath);
  const stats = filePath === sourcePath ? sourceStats : await fs.promises.stat(filePath);
  return {
    filePath,
    sourcePath,
    kind: "jsonl",
    sessionId: source.sessionId,
    size: stats.size,
    mtimeMs: sourceStats.mtimeMs,
    device: stats.dev,
    inode: stats.ino,
  };
}

async function listUsageCountedTranscriptFileSources(
  agentId: string,
  params: {
    eventTimeRange?: SessionTranscriptEventTimeRange;
    sessionsDir: string;
    storePath: string;
  } & UsageCostCollectionAccess,
): Promise<UsageCostJsonlSource[]> {
  const { sessionsDir, storePath } = params;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const transcripts = entries.filter(
    (entry) => entry.isFile() && isUsageCountedSessionTranscriptFileName(entry.name),
  );
  const archiveNames = transcripts.map((entry) => entry.name);
  const stores = new Map(
    transcripts.length > 0
      ? listDurableSqliteTargetPathsForSessionStorePath(storePath).map((databasePath) => [
          resolveRealpathOrAbsolute(databasePath),
          databasePath,
        ])
      : [],
  );
  const archivesByStore = [];
  for (const databasePath of stores.values()) {
    const read = () =>
      listSessionTranscriptArchivesReadOnly({
        agentId,
        archiveNames,
        includeAllAgents: true,
        storePath: databasePath,
        env: params.env,
      });
    archivesByStore.push(
      params.readSqliteMetadata ? await params.readSqliteMetadata(databasePath, read) : read(),
    );
  }
  const archives = new Map(archivesByStore.flat().map((archive) => [archive.archiveName, archive]));
  const tasks = transcripts
    .filter((entry) => (archives.get(entry.name)?.agentId ?? agentId) === agentId)
    .map((entry) => async (): Promise<UsageCostJsonlSource | undefined> => {
      const filePath = path.join(sessionsDir, entry.name);
      try {
        const stats = await fs.promises.stat(filePath);
        return {
          kind: "jsonl",
          sourcePath: filePath,
          sessionId:
            archives.get(entry.name)?.sessionId ??
            parseUsageCountedSessionIdFromFileName(entry.name) ??
            undefined,
          mtimeMs: stats.mtimeMs,
          stats,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    });
  const { firstError, hasError, results } = await runTasksWithConcurrency({
    tasks,
    limit: USAGE_COST_TRANSCRIPT_STAT_CONCURRENCY,
  });
  if (hasError) {
    throw firstError;
  }
  const candidates = results.filter((file): file is UsageCostJsonlSource => Boolean(file));
  if (!params.eventTimeRange) {
    return candidates;
  }
  const preflight = await runTasksWithConcurrency({
    tasks: candidates.map((source) => async () => {
      if (
        transcriptMetadataMayOverlapRange(source.mtimeMs, params.eventTimeRange!) ||
        // A live JSONL modified after the requested end may still have in-range events.
        // Include it for queued refresh instead of opening its stream in a summary preflight.
        // Old-mtime files and compressed cold archives still require content preflight.
        (source.sourcePath.endsWith(".jsonl") &&
          params.eventTimeRange!.endMs !== undefined &&
          source.mtimeMs > params.eventTimeRange!.endMs)
      ) {
        return source;
      }
      return (await transcriptSourceOverlapsRange(source.sourcePath, params.eventTimeRange!))
        ? source
        : undefined;
    }),
    limit: USAGE_COST_EVENT_TIME_PREFLIGHT_CONCURRENCY,
  });
  if (preflight.hasError) {
    throw preflight.firstError;
  }
  return preflight.results.filter((file): file is UsageCostJsonlSource => Boolean(file));
}

async function transcriptSourceOverlapsRange(
  sourcePath: string,
  range: SessionTranscriptEventTimeRange,
): Promise<boolean> {
  const compressed = sourcePath.endsWith(".zst");
  // SAFETY: Node versions without the optional zstd API are rejected before invocation.
  const createZstdDecompress = (zlib as Partial<typeof zlib>).createZstdDecompress;
  if (compressed && !createZstdDecompress) {
    throw new Error("Cannot scan compressed transcript archive: this runtime lacks zstd support");
  }
  const input = fs.createReadStream(sourcePath);
  const output = compressed ? createZstdDecompress!.call(zlib) : new PassThrough();
  const completed = pipeline(input, output);
  let overlapsRange = false;
  try {
    for await (const record of readTranscriptArchiveRecords(
      output,
      MAX_TASK_ARCHIVE_RECORD_BYTES,
    )) {
      if (transcriptEventJsonMayOverlapRange(record.toString("utf8"), range)) {
        overlapsRange = true;
        break;
      }
    }
    if (!overlapsRange) {
      await completed;
    }
    return overlapsRange;
  } catch (error) {
    if (error instanceof Error && error.message === TASK_ARCHIVE_RECORD_CAPACITY_ERROR) {
      return true;
    }
    throw error;
  } finally {
    input.destroy();
    output.destroy();
    await completed.catch(() => undefined);
  }
}

async function readUsageCostSqliteFiles(
  markers: SqliteSessionFileMarker[],
  access: UsageCostCollectionAccess = {},
): Promise<Array<UsageCostSqliteFile | undefined>> {
  const scopes = markers.map((marker) => ({ ...marker, env: access.env }));
  const statsByIndex = access.readSqliteStats
    ? await access.readSqliteStats(markers)
    : scopes.length === 1
      ? scopes.map(readTranscriptStatsSync)
      : readTranscriptStatsBatchReadOnlySync(scopes);
  return markers.map((marker, index): UsageCostSqliteFile | undefined => {
    const stats = statsByIndex[index];
    if (!stats) {
      return undefined;
    }
    const filePath = formatCanonicalUsageCostSqliteMarker(marker, access.env);
    return {
      filePath,
      sourcePath: filePath,
      kind: "sqlite",
      mtimeMs: stats.lastMutationAtMs ?? 0,
      sessionId: marker.sessionId,
      size: stats.sizeBytes,
      eventCount: stats.eventCount,
      maxSeq: stats.maxSeq,
    };
  });
}

function formatCanonicalUsageCostSqliteMarker(
  marker: SqliteSessionFileMarker,
  env?: NodeJS.ProcessEnv,
): string {
  const { path: storePath } = resolveSqliteTargetFromSessionStorePath(marker.storePath, {
    agentId: marker.agentId,
    env,
  });
  return formatSqliteSessionFileMarker({ ...marker, storePath });
}

export async function listUsageCountedTranscriptSources(
  agentId: string,
  params?: {
    eventTimeRange?: SessionTranscriptEventTimeRange;
    sessionsDir?: string;
    storePath?: string;
  } & UsageCostCollectionAccess,
): Promise<UsageCostTranscriptSource[]> {
  const logicalAgentId = normalizeAgentId(agentId);
  const storePath = resolveSessionStorePathForScope({
    agentId,
    env: params?.env,
    storePath:
      params?.storePath ??
      (params?.sessionsDir ? path.join(params.sessionsDir, "sessions.json") : undefined),
  });
  const sessionsDir = params?.sessionsDir ?? resolveSessionArtifactDirectory(storePath);
  const fileBacked = await listUsageCountedTranscriptFileSources(logicalAgentId, {
    eventTimeRange: params?.eventTimeRange,
    sessionsDir,
    storePath,
    env: params?.env,
    readSqliteMetadata: params?.readSqliteMetadata,
    materializeArchive: params?.materializeArchive,
  });
  const instances = params?.listSqliteInstances
    ? await params.listSqliteInstances(agentId, storePath, Boolean(params.eventTimeRange))
    : listSessionTranscriptInstances(
        { agentId, storePath, env: params?.env, projection: "list" },
        { includeAllWindows: Boolean(params?.eventTimeRange) },
      ).filter((instance) => !isInternalSessionEffectsKey(instance.sessionKey));
  const sqliteCandidates = instances.filter((instance) => instance.agentId === logicalAgentId);
  const candidateMarkers = sqliteCandidates.map((instance) => ({
    agentId: logicalAgentId,
    sessionId: instance.sessionId,
    storePath,
  }));
  const candidateFiles = await readUsageCostSqliteFiles(candidateMarkers, params);
  const sqliteMarkers = params?.eventTimeRange
    ? await runTasksWithConcurrency({
        tasks: sqliteCandidates.map((instance, index) => async () => {
          const marker: SqliteSessionFileMarker = {
            agentId: logicalAgentId,
            sessionId: instance.sessionId,
            storePath,
          };
          const file = candidateFiles[index];
          if (!file) {
            return undefined;
          }
          const cachedDecision = params.preflightSqliteEventTime
            ? await params.preflightSqliteEventTime(
                marker,
                params.eventTimeRange!,
                instance.updatedAtMs,
                file,
              )
            : undefined;
          const overlapsRange =
            cachedDecision ??
            (await sessionTranscriptEventsOverlapRange(
              marker,
              params.eventTimeRange!,
              instance.updatedAtMs,
              params.env,
            ));
          return overlapsRange ? marker : undefined;
        }),
        limit: USAGE_COST_EVENT_TIME_PREFLIGHT_CONCURRENCY,
      }).then((result) => {
        if (result.hasError) {
          throw result.firstError;
        }
        return result.results.filter((marker): marker is SqliteSessionFileMarker =>
          Boolean(marker),
        );
      })
    : candidateMarkers;
  const includedIds = new Set(sqliteMarkers.map((marker) => marker.sessionId));
  const sqliteBacked = candidateFiles.filter((file): file is UsageCostSqliteFile =>
    Boolean(file && includedIds.has(file.sessionId ?? "")),
  );
  const sqliteSessionIds = new Set(sqliteBacked.map((file) => file.sessionId).filter(Boolean));
  const canonicalFileBacked = fileBacked.filter(
    (file) => !file.sessionId || !sqliteSessionIds.has(file.sessionId),
  );
  return [...canonicalFileBacked, ...sqliteBacked];
}

export async function listUsageCountedTranscriptStats(
  agentId: string,
  params?: {
    eventTimeRange?: SessionTranscriptEventTimeRange;
    sessionsDir?: string;
    storePath?: string;
  } & UsageCostCollectionAccess,
): Promise<UsageCostTranscriptFile[]> {
  const sources = await listUsageCountedTranscriptSources(agentId, params);
  // Discovery and SQLite precedence need only metadata; expand archives only for readers.
  const { firstError, hasError, results } = await runTasksWithConcurrency({
    tasks: sources.map((source) => async (): Promise<UsageCostTranscriptFile | undefined> => {
      try {
        return await materializeUsageCostTranscriptSource(source, params);
      } catch (error) {
        if (hasErrnoCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      }
    }),
    limit: USAGE_COST_TRANSCRIPT_STAT_CONCURRENCY,
  });
  if (hasError) {
    throw firstError;
  }
  return results.filter((file): file is UsageCostTranscriptFile => Boolean(file));
}

async function resolveUsageCostTranscriptSource(
  sessionFile: string,
  access?: UsageCostCollectionAccess,
): Promise<UsageCostTranscriptSource | undefined> {
  const marker = parseSqliteSessionFileMarker(sessionFile);
  if (marker) {
    return (await readUsageCostSqliteFiles([marker], access))[0];
  }
  try {
    const stats = await fs.promises.stat(sessionFile);
    return {
      kind: "jsonl",
      sourcePath: sessionFile,
      sessionId: parseUsageCountedSessionIdFromFileName(path.basename(sessionFile)) ?? undefined,
      mtimeMs: stats.mtimeMs,
      stats,
    };
  } catch {
    return undefined;
  }
}

export async function resolveUsageCostTranscriptSources(
  sessionFiles: readonly string[],
  access?: UsageCostCollectionAccess,
): Promise<Array<UsageCostTranscriptSource | undefined>> {
  const markers = sessionFiles.map(parseSqliteSessionFileMarker);
  const sqliteFiles = await readUsageCostSqliteFiles(
    markers.filter((marker) => marker !== undefined),
    access,
  );
  if (sqliteFiles.length === sessionFiles.length) {
    return sqliteFiles;
  }
  let sqliteIndex = 0;
  const tasks = sessionFiles.map((sessionFile, index) => {
    if (markers[index]) {
      const file = sqliteFiles[sqliteIndex++];
      return async () => file;
    }
    return () => resolveUsageCostTranscriptSource(sessionFile, access);
  });
  const { results } = await runTasksWithConcurrency({
    tasks,
    limit: USAGE_COST_TRANSCRIPT_STAT_CONCURRENCY,
  });
  return results;
}

export async function resolveUsageCostTranscriptFile(
  sessionFile: string,
  access?: UsageCostCollectionAccess,
): Promise<UsageCostTranscriptFile | undefined> {
  const source = await resolveUsageCostTranscriptSource(sessionFile, access);
  return materializeUsageCostTranscriptSourceBestEffort(source, access);
}

async function materializeUsageCostTranscriptSourceBestEffort(
  source: UsageCostTranscriptSource | undefined,
  access?: UsageCostCollectionAccess,
): Promise<UsageCostTranscriptFile | undefined> {
  if (!source) {
    return undefined;
  }
  try {
    return await materializeUsageCostTranscriptSource(source, access);
  } catch {
    return undefined;
  }
}

export async function resolveUsageCostTranscriptFiles(
  sessionFiles: readonly string[],
  access?: UsageCostCollectionAccess,
): Promise<Array<UsageCostTranscriptFile | undefined>> {
  const sources = await resolveUsageCostTranscriptSources(sessionFiles, access);
  const { results } = await runTasksWithConcurrency({
    tasks: sources.map(
      (source) => () => materializeUsageCostTranscriptSourceBestEffort(source, access),
    ),
    limit: USAGE_COST_TRANSCRIPT_STAT_CONCURRENCY,
  });
  return results;
}

export async function* readTranscriptRecords(
  filePath: string,
): AsyncGenerator<Record<string, unknown>> {
  const marker = parseSqliteSessionFileMarker(filePath);
  if (marker) {
    const { restoreSessionColdTranscript } =
      await import("../config/sessions/session-cold-storage.js");
    await restoreSessionColdTranscript(marker);
    for (const event of selectVisibleTranscriptEvents(loadTranscriptEventsSync(marker))) {
      if (isRecord(event)) {
        yield event;
      }
    }
    return;
  }
  // Durable byte-offset scans own their checkpoint reader. Diagnostic history
  // shares the canonical transcript stream and materializes archive bytes once.
  const transcriptPath = materializeSessionArchiveForRead(filePath);
  for await (const line of streamSessionTranscriptLines(transcriptPath)) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) {
        yield parsed;
      }
    } catch {
      // Historical transcripts can contain malformed records.
    }
  }
}

export async function* readTranscriptRecordsBestEffort(
  filePath: string,
): AsyncGenerator<Record<string, unknown>> {
  try {
    yield* readTranscriptRecords(filePath);
  } catch (error) {
    if (parseSqliteSessionFileMarker(filePath)) {
      throw error;
    }
    // Diagnostic readers return the records available before a stream failure.
    // Durable cache scans use the strict reader so partial data is never marked fresh.
  }
}

export function resolveExistingUsageSessionFile(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  agentId: string;
  sessionTarget?: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  };
}): string | undefined {
  const sessionId = normalizeOptionalString(params.sessionId);
  const target = params.sessionTarget
    ? {
        agentId: normalizeOptionalString(params.sessionTarget.agentId),
        sessionId: normalizeOptionalString(params.sessionTarget.sessionId),
        sessionKey: normalizeOptionalString(params.sessionTarget.sessionKey),
        storePath: normalizeOptionalString(params.sessionTarget.storePath),
      }
    : undefined;
  const completeTarget = Boolean(
    target?.agentId && target.sessionId && target.sessionKey && target.storePath,
  );
  if (target && completeTarget) {
    const targetKeyAgentId = parseAgentSessionKey(target.sessionKey)?.agentId;
    const targetKeyEntry = loadSessionEntryReadOnly({
      agentId: target.agentId!,
      sessionKey: target.sessionKey!,
      storePath: target.storePath!,
      projection: "list",
    });
    // Complete targets remain authoritative after metadata cleanup; reject
    // only an existing key row that proves the identity is stale.
    if (
      (sessionId !== undefined && target.sessionId !== sessionId) ||
      target.agentId !== params.agentId ||
      (targetKeyAgentId && targetKeyAgentId !== target.agentId) ||
      (targetKeyEntry && targetKeyEntry.sessionId !== target.sessionId)
    ) {
      return undefined;
    }
    return formatCanonicalUsageCostSqliteMarker({
      agentId: target.agentId!,
      sessionId: target.sessionId!,
      storePath: target.storePath!,
    });
  }
  const legacySessionFile = (params.sessionEntry as { sessionFile?: unknown } | undefined)
    ?.sessionFile;
  const entryMarker = parseSqliteSessionFileMarker(
    typeof legacySessionFile === "string" ? legacySessionFile : undefined,
  );
  const explicitMarker = parseSqliteSessionFileMarker(params.sessionFile);
  const matchingEntryMarker =
    entryMarker &&
    entryMarker.agentId === params.agentId &&
    (!sessionId || entryMarker.sessionId === sessionId)
      ? entryMarker
      : undefined;
  const matchingExplicitMarker =
    explicitMarker &&
    explicitMarker.agentId === params.agentId &&
    (!sessionId || explicitMarker.sessionId === sessionId)
      ? explicitMarker
      : undefined;
  if (!matchingEntryMarker && explicitMarker && !matchingExplicitMarker) {
    return undefined;
  }
  const sqliteMarker = matchingEntryMarker ?? matchingExplicitMarker;
  const targetKeyAgentId = parseAgentSessionKey(target?.sessionKey)?.agentId;
  const targetKeyEntry =
    target?.sessionKey && sqliteMarker && !completeTarget
      ? loadSessionEntryReadOnly({
          agentId: sqliteMarker.agentId,
          sessionKey: target.sessionKey,
          storePath: sqliteMarker.storePath,
          projection: "list",
        })
      : undefined;
  if (
    target &&
    !completeTarget &&
    sqliteMarker &&
    ((target.agentId && target.agentId !== sqliteMarker.agentId) ||
      (target.sessionId && target.sessionId !== sqliteMarker.sessionId) ||
      (targetKeyAgentId && targetKeyAgentId !== sqliteMarker.agentId) ||
      (target.sessionKey && targetKeyEntry?.sessionId !== sqliteMarker.sessionId) ||
      (target.storePath && path.resolve(target.storePath) !== path.resolve(sqliteMarker.storePath)))
  ) {
    return undefined;
  }
  if (sqliteMarker) {
    return formatSqliteSessionFileMarker(sqliteMarker);
  }
  // An explicit JSONL artifact remains a supported read boundary, but a stale
  // entry marker alone must not redirect the requested session.
  if (entryMarker && !params.sessionFile) {
    return undefined;
  }

  const candidate =
    params.sessionFile ??
    (sessionId
      ? resolveSessionFilePathCore(sessionId, params.sessionEntry, {
          agentId: params.agentId,
        })
      : undefined);

  if (candidate && fs.existsSync(candidate)) {
    return candidate;
  }
  if (!sessionId) {
    return candidate;
  }

  try {
    const sessionsDir = candidate
      ? path.dirname(candidate)
      : resolveSessionTranscriptsDirForAgent(params.agentId);
    const baseFileName = `${sessionId}.jsonl`;
    const entries = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => {
      return (
        entry.isFile() &&
        (entry.name === baseFileName ||
          entry.name.startsWith(`${baseFileName}.reset.`) ||
          entry.name.startsWith(`${baseFileName}.deleted.`))
      );
    });

    const primary = entries.find((entry) => entry.name === baseFileName);
    if (primary) {
      return path.join(sessionsDir, primary.name);
    }

    const latestArchive = entries
      .filter((entry) => isSessionArchiveArtifactName(entry.name))
      .map((entry) => entry.name)
      .toSorted((a, b) => {
        const tsA =
          parseSessionArchiveTimestamp(a, "deleted") ??
          parseSessionArchiveTimestamp(a, "reset") ??
          0;
        const tsB =
          parseSessionArchiveTimestamp(b, "deleted") ??
          parseSessionArchiveTimestamp(b, "reset") ??
          0;
        return tsB - tsA || b.localeCompare(a);
      })[0];

    return latestArchive ? path.join(sessionsDir, latestArchive) : candidate;
  } catch {
    return candidate;
  }
}
