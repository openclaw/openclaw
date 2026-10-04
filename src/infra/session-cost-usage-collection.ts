import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { materializeSessionArchiveForRead } from "../config/sessions/archive-compression.js";
import {
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  parseSessionArchiveTimestamp,
  parseUsageCountedSessionIdFromFileName,
} from "../config/sessions/artifacts.js";
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
import type { SessionTranscriptStats } from "../config/sessions/session-accessor.sqlite-contract.js";
import { listSessionTranscriptArchivesReadOnly } from "../config/sessions/session-accessor.sqlite-history.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  listDurableSqliteTargetPathsForSessionStorePath,
  prepareSqliteTargetFromSessionStorePath,
  resolveSqliteTargetFromSessionStorePath,
} from "../config/sessions/session-sqlite-target.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { streamSessionTranscriptLines } from "../config/sessions/transcript-stream.js";
import { selectVisibleTranscriptEvents } from "../config/sessions/transcript-visible-events.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { resolveRealpathOrAbsolute } from "./boundary-path.js";
import { hasErrnoCode } from "./errno.js";
import type { UsageCostTranscriptFile } from "./session-cost-usage.types.js";

const USAGE_COST_TRANSCRIPT_STAT_CONCURRENCY = 32;

export type UsageCostCollectionAccess = {
  env?: NodeJS.ProcessEnv;
  materializeArchive: (sourcePath: string) => Promise<string>;
  readSqliteMetadata: <T>(storePath: string, read: () => T) => Promise<T>;
  listSqliteInstances: (
    agentId: string,
    storePath: string,
  ) => Promise<Array<{ agentId: string; sessionId: string; updatedAtMs: number }>>;
  readSqliteStats: (
    markers: readonly SqliteSessionFileMarker[],
  ) => Promise<Array<SessionTranscriptStats | undefined>>;
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
  access: UsageCostCollectionAccess,
): Promise<UsageCostTranscriptFile> {
  if (source.kind === "sqlite") {
    return source;
  }
  const { sourcePath, stats: sourceStats } = source;
  // Identity and freshness belong to the source; incremental offsets and
  // byte signatures must describe the decompressed file used by readers.
  const filePath = await access.materializeArchive(sourcePath);
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
    minMtimeMs?: number;
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
    archivesByStore.push(await params.readSqliteMetadata(databasePath, read));
  }
  const archives = new Map(archivesByStore.flat().map((archive) => [archive.archiveName, archive]));
  const tasks = transcripts
    .filter((entry) => (archives.get(entry.name)?.agentId ?? agentId) === agentId)
    .map((entry) => async (): Promise<UsageCostJsonlSource | undefined> => {
      const filePath = path.join(sessionsDir, entry.name);
      try {
        const stats = await fs.promises.stat(filePath);
        if (params.minMtimeMs !== undefined && stats.mtimeMs < params.minMtimeMs) {
          return undefined;
        }
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
  return results.filter((file): file is UsageCostJsonlSource => Boolean(file));
}

async function readUsageCostSqliteFiles(
  markers: SqliteSessionFileMarker[],
  access: UsageCostCollectionAccess,
): Promise<Array<UsageCostSqliteFile | undefined>> {
  const statsByIndex = await access.readSqliteStats(markers);
  return markers.map((marker, index): UsageCostSqliteFile | undefined => {
    const stats = statsByIndex[index];
    if (!stats) {
      return undefined;
    }
    const { path: storePath } = resolveSqliteTargetFromSessionStorePath(marker.storePath, {
      agentId: marker.agentId,
      env: access.env,
    });
    const filePath = formatSqliteSessionFileMarker({ ...marker, storePath });
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

export async function listUsageCountedTranscriptSources(
  agentId: string,
  params: {
    minMtimeMs?: number;
    sessionsDir?: string;
    storePath?: string;
  } & UsageCostCollectionAccess,
): Promise<UsageCostTranscriptSource[]> {
  const logicalAgentId = normalizeAgentId(agentId);
  const storePath = resolveSessionStorePathForScope({
    agentId,
    env: params.env,
    storePath:
      params.storePath ??
      (params.sessionsDir ? path.join(params.sessionsDir, "sessions.json") : undefined),
  });
  const sessionsDir = params.sessionsDir ?? resolveSessionArtifactDirectory(storePath);
  const fileBacked = await listUsageCountedTranscriptFileSources(logicalAgentId, {
    ...params,
    sessionsDir,
    storePath,
  });
  const instances = await params.listSqliteInstances(agentId, storePath);
  const sqliteBacked = (
    await readUsageCostSqliteFiles(
      instances
        .filter(
          (instance) =>
            instance.agentId === logicalAgentId &&
            (params.minMtimeMs === undefined || instance.updatedAtMs >= params.minMtimeMs),
        )
        .map((instance) => ({ agentId: logicalAgentId, sessionId: instance.sessionId, storePath })),
      params,
    )
  ).filter((file) => file !== undefined);
  const sqliteSessionIds = new Set(sqliteBacked.map((file) => file.sessionId).filter(Boolean));
  const canonicalFileBacked = fileBacked.filter(
    (file) => !file.sessionId || !sqliteSessionIds.has(file.sessionId),
  );
  return [...canonicalFileBacked, ...sqliteBacked];
}

export async function listUsageCountedTranscriptStats(
  agentId: string,
  params: {
    minMtimeMs?: number;
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
  access: UsageCostCollectionAccess,
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
  access: UsageCostCollectionAccess,
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
  access: UsageCostCollectionAccess,
): Promise<UsageCostTranscriptFile | undefined> {
  const source = await resolveUsageCostTranscriptSource(sessionFile, access);
  return materializeUsageCostTranscriptSourceBestEffort(source, access);
}

async function materializeUsageCostTranscriptSourceBestEffort(
  source: UsageCostTranscriptSource | undefined,
  access: UsageCostCollectionAccess,
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
  access: UsageCostCollectionAccess,
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

export async function resolveUsageSessionSource(params: {
  sessionId?: string;
  sessionFile?: string;
  agentId: string;
  sessionTarget?: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  };
}): Promise<{ sessionFile: string; entry?: SessionEntry } | undefined> {
  const signal = getAsyncWorkSignal();
  const assertCurrent = () => signal?.throwIfAborted();
  assertCurrent();
  const sessionId = normalizeOptionalString(params.sessionId);
  const target = params.sessionTarget;
  if (target) {
    const agentId = normalizeOptionalString(target.agentId);
    const targetSessionId = normalizeOptionalString(target.sessionId);
    const sessionKey = normalizeOptionalString(target.sessionKey);
    const storePath = normalizeOptionalString(target.storePath);
    if (!agentId || !targetSessionId || !sessionKey || !storePath) {
      return undefined;
    }
    const targetKeyAgentId = parseAgentSessionKey(sessionKey)?.agentId;
    if (
      (sessionId !== undefined && targetSessionId !== sessionId) ||
      agentId !== params.agentId ||
      (targetKeyAgentId && targetKeyAgentId !== agentId)
    ) {
      return undefined;
    }
    return withSessionEntryReadOnlyInWorker(
      { agentId, sessionKey, storePath, projection: "list" },
      assertCurrent,
      async (read, owner) => {
        if (!read.ok) {
          throw read.error;
        }
        // A retained transcript can outlive its metadata row, but never its successor.
        if (read.value && read.value.sessionId !== targetSessionId) {
          return undefined;
        }
        const physicalPath =
          owner.scope?.storePath ??
          (await prepareSqliteTargetFromSessionStorePath(storePath, { agentId }, signal)).path;
        owner.assertCurrent();
        return {
          entry: read.value,
          sessionFile: formatSqliteSessionFileMarker({
            agentId,
            sessionId: targetSessionId,
            storePath: physicalPath,
          }),
        };
      },
    );
  }
  const sqliteMarker = parseSqliteSessionFileMarker(params.sessionFile);
  if (sqliteMarker) {
    if (
      sqliteMarker.agentId !== params.agentId ||
      (sessionId && sqliteMarker.sessionId !== sessionId)
    ) {
      return undefined;
    }
    return { sessionFile: formatSqliteSessionFileMarker(sqliteMarker) };
  }

  const candidate =
    params.sessionFile ??
    (sessionId
      ? resolveSessionFilePathCore(sessionId, undefined, {
          agentId: params.agentId,
        })
      : undefined);

  if (candidate && fs.existsSync(candidate)) {
    return { sessionFile: candidate };
  }
  if (!sessionId) {
    return candidate ? { sessionFile: candidate } : undefined;
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
      return { sessionFile: path.join(sessionsDir, primary.name) };
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

    const sessionFile = latestArchive ? path.join(sessionsDir, latestArchive) : candidate;
    return sessionFile ? { sessionFile } : undefined;
  } catch {
    return candidate ? { sessionFile: candidate } : undefined;
  }
}
