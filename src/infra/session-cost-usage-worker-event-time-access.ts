import fs from "node:fs";
import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import { materializeSessionArchiveForRead } from "../config/sessions/archive-compression.js";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import type { SqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { SessionTranscriptStats } from "../config/sessions/session-accessor.sqlite-contract.js";
import { listSessionTranscriptInstances } from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  readSessionTranscriptEventTimeSourceFromDatabase,
  sessionTranscriptEventTimeSourceOverlapsRange,
  sessionTranscriptEventsOverlapRange,
} from "../config/sessions/session-accessor.sqlite-event-time.js";
import { readTranscriptStatsBatchReadOnlySync } from "../config/sessions/session-accessor.sqlite-read.js";
import { resolveSessionColdArchivePath } from "../config/sessions/session-cold-storage-codec.js";
import {
  readSessionColdTranscript,
  type SessionColdArchive,
} from "../config/sessions/session-cold-storage-state.js";
import type { SessionTranscriptEventTimeRange } from "../config/sessions/transcript-event-time.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import type { UsageCostCollectionAccess } from "./session-cost-usage-collection.js";
import type {
  CachedSummaryEventTimeLookup,
  UsageCostWorkerDatabase,
  UsageCostWorkerHostEffects,
  UsageCostWorkerInput,
} from "./session-cost-usage-worker.types.js";

type ReadStore = <T>(agentId: string, storePath: string, read: () => T | Promise<T>) => Promise<T>;
type Host = <Kind extends keyof UsageCostWorkerHostEffects>(
  kind: Kind,
  input: UsageCostWorkerHostEffects[Kind]["input"],
  transfer?: ArrayBuffer[],
) => Promise<UsageCostWorkerHostEffects[Kind]["output"]>;

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

export function createUsageCostEventTimeCollectionAccess(params: {
  input: UsageCostWorkerInput;
  control: WorkerTaskControl;
  target: (agentId: string, storePath: string) => UsageCostWorkerDatabase;
  readStore: ReadStore;
  host: Host;
  minMtimeMs: number | undefined;
  cachedSummaryEventTimeLookup: () => CachedSummaryEventTimeLookup | undefined;
}): UsageCostCollectionAccess {
  const { input, control, target, readStore, host, minMtimeMs } = params;
  const { location, operation } = input;
  const { env } = location;
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
      return minMtimeMs === undefined || includeAllWindows
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
        const cachedDecision = await params.cachedSummaryEventTimeLookup()?.(marker, range, file);
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
        const cachedDecision = await params.cachedSummaryEventTimeLookup()?.(marker, range, file);
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
  return access;
}
