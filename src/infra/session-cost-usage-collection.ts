import fs from "node:fs";
import path from "node:path";
import {
  isUsageCountedSessionTranscriptFileName,
  parseUsageCountedSessionIdFromFileName,
} from "../config/sessions/artifacts.js";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
  type SqliteSessionFileMarker,
} from "../config/sessions/legacy-sqlite-marker.js";
import { resolveSessionArtifactDirectory } from "../config/sessions/paths.js";
import type { SessionTranscriptStats } from "../config/sessions/session-accessor.sqlite-contract.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { resolveRealpathOrAbsolute } from "./boundary-path.js";
import { hasErrnoCode } from "./errno.js";
import type { UsageCostTranscriptFile } from "./session-cost-usage.types.js";

const USAGE_COST_TRANSCRIPT_STAT_CONCURRENCY = 32;

export type UsageCostCollectionAccess = {
  env?: NodeJS.ProcessEnv;
  materializeArchive: (sourcePath: string) => Promise<string>;
  listSqliteMetadataStores: (storePath: string) => readonly string[];
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
      ? params
          .listSqliteMetadataStores(storePath)
          .map((databasePath) => [resolveRealpathOrAbsolute(databasePath), databasePath])
      : [],
  );
  const archivesByStore = [];
  for (const databasePath of stores.values()) {
    const { listSessionTranscriptArchivesReadOnly } =
      await import("../config/sessions/session-accessor.sqlite-history.js");
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

/** Resolve cache keys before deciding which transcripts need freshness statistics. */
export async function resolveUsageCostTranscriptPaths(
  sessionFiles: readonly string[],
  access: UsageCostCollectionAccess,
): Promise<Array<string | undefined>> {
  // Physical ownership is stable for this batch; every actual read retains database custody.
  const storePaths = new Map<string, string>();
  const { results, hasError, firstError } = await runTasksWithConcurrency({
    tasks: sessionFiles.map((sessionFile) => async () => {
      const marker = parseSqliteSessionFileMarker(sessionFile);
      if (marker) {
        const targetKey = JSON.stringify([marker.agentId, marker.storePath]);
        let storePath = storePaths.get(targetKey);
        if (storePath === undefined) {
          storePath = resolveSqliteTargetFromSessionStorePath(marker.storePath, {
            agentId: marker.agentId,
            env: access.env,
          }).path;
          storePaths.set(targetKey, storePath);
        }
        return formatSqliteSessionFileMarker({ ...marker, storePath });
      }
      try {
        return await access.materializeArchive(sessionFile);
      } catch {
        return undefined;
      }
    }),
    limit: USAGE_COST_TRANSCRIPT_STAT_CONCURRENCY,
  });
  if (hasError) {
    throw firstError;
  }
  return results;
}
