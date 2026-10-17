import fs from "node:fs";
import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import { sessionTranscriptEventTimeSourceOverlapsRange } from "../config/sessions/session-accessor.sqlite-event-time.js";
import { readSessionTranscriptEventTimeSourceFromDatabase } from "../config/sessions/session-accessor.sqlite-event-time.worker.js";
import { resolveSessionColdArchivePath } from "../config/sessions/session-cold-storage-codec.js";
import {
  readSessionColdTranscript,
  type SessionColdArchive,
} from "../config/sessions/session-cold-storage-state.js";
import type { SessionTranscriptEventTimeRange } from "../config/sessions/transcript-event-time.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { UsageCostCollectionAccess } from "./session-cost-usage-collection.js";
import type {
  CachedSummaryEventTimeLookup,
  UsageCostWorkerDatabase,
  UsageCostWorkerInput,
} from "./session-cost-usage-worker.types.js";

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

/** Decorate the current captured collection owner with worker-local event-time evidence.
 * Actor-backed memory is handled by its acquired actor, never by a new host SQL effect. */
export function createUsageCostEventTimePreflight(params: {
  input: UsageCostWorkerInput;
  control: WorkerTaskControl;
  target: (agentId: string, storePath: string) => UsageCostWorkerDatabase;
  readStore: <T>(agentId: string, storePath: string, read: () => T) => Promise<T>;
  cachedSummaryEventTimeLookup: () => CachedSummaryEventTimeLookup | undefined;
}): NonNullable<UsageCostCollectionAccess["preflightSqliteEventTime"]> {
  const { input, control, target, readStore } = params;
  const { env } = input.location;
  return async (marker, range, updatedAtMs, file) => {
    control.throwIfCancelled();
    const database = target(marker.agentId, marker.storePath);
    const currentArchive =
      input.operation.kind === "summary"
        ? await readStore(marker.agentId, marker.storePath, () => {
            const result = withOpenClawAgentDatabaseReadOnly(
              (opened) => readSessionColdTranscript(opened.db, marker.sessionId),
              { ...database, env },
            );
            return result.found ? result.value : undefined;
          })
        : undefined;
    if (currentArchive) {
      const cachedDecision = await params.cachedSummaryEventTimeLookup()?.(marker, range, file);
      control.throwIfCancelled();
      if (cachedDecision !== undefined) {
        return cachedDecision;
      }
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
          readSessionTranscriptEventTimeSourceFromDatabase(
            opened,
            marker,
            range,
            // Inventory is an exact filter, not the conservative summary fast path.
            input.operation.kind === "inventory" ? undefined : updatedAtMs,
          ),
        { ...database, env },
      );
      if (!result.found) {
        throw new Error(`Usage transcript database is unavailable for ${marker.sessionId}`);
      }
      return result.value;
    });
    const overlaps = await sessionTranscriptEventTimeSourceOverlapsRange(source, range);
    control.throwIfCancelled();
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
  };
}
