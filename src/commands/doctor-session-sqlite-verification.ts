/** Offline destination ownership and conservative adoption of historical import evidence. */
import fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveLegacyTranscriptPaths } from "../config/sessions/legacy-store-inspection.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import { normalizeStoreSessionKey } from "../config/sessions/store-entry.js";
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import { readFileDescriptorBoundedSync } from "../infra/boundary-file-read.js";
import { executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import {
  readMigrationArtifactIdentity,
  type MigrationArtifact,
} from "../infra/session-sqlite-migration-artifact.js";
import {
  canonicalMigrationFilePath,
  uniqueRestoreMoves,
  type SessionSqliteMigrationMove,
  type SessionSqliteMigrationTargetManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import {
  countTranscriptEventsForPath,
  readOnlySqliteValidationSnapshot,
  type ReadOnlySqliteValidationSnapshot,
} from "../infra/session-sqlite-migration-readers.js";
import {
  verifyTranscriptEvents,
  verifyCanonicalSessionTranscriptSources,
} from "../infra/session-sqlite-transcript-verification.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { normalizeLegacySessionEntryDelivery } from "../infra/state-migrations.legacy-session-store.js";
import { migrateLegacySessionCreator } from "../state/creator-namespace-migration.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { inspectOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db.js";
import type { LegacySessionRecord } from "./doctor-session-sqlite-discovery.js";
import type { DoctorSessionSqliteTargetReport } from "./doctor-session-sqlite-types.js";
import { assertDoctorSqliteMaintenancePathsNotAliased } from "./doctor-sqlite-maintenance-lock.js";

/** Keep one owner proof per database; fence in-place writes and sidecar changes after awaits. */
export function createRecoveryDestinationVerifier(stateDir: string) {
  const destinations = new Map<
    string,
    { agentId: string; files: (fs.BigIntStats | undefined)[] }
  >();
  return (refs: Iterable<{ target: SessionSqliteMigrationTargetManifest }>) => {
    for (const { target } of refs) {
      const paths = resolveSqliteDatabaseFilePaths(target.sqlitePath);
      assertDoctorSqliteMaintenancePathsNotAliased("update recovery cleanup", paths, [stateDir]);
      const expected = destinations.get(target.sqlitePath);
      if (!expected) {
        const owner = inspectOpenClawAgentDatabaseOwner(target.sqlitePath);
        if (owner.status !== "owned" || owner.agentId !== target.agentId) {
          throw new Error("destination database ownership cannot be verified");
        }
      }
      // Even a read-only SQLite connection can create WAL/SHM files. Establish the baseline
      // after owner inspection closes it; later checks only stat, never reopen or hash the DB.
      const files = paths.map((file) =>
        fs.lstatSync(file, { bigint: true, throwIfNoEntry: false }),
      );
      if (
        !files[0]?.isFile() ||
        files.some((file) => file && (!file.isFile() || file.nlink !== 1n)) ||
        (expected &&
          (expected.agentId !== target.agentId ||
            files.some((file, index) =>
              (["dev", "ino", "ctimeNs", "mtimeNs", "size"] as const).some(
                (key) => file?.[key] !== expected.files[index]?.[key],
              ),
            )))
      ) {
        throw new Error("Recovery destination database changed; preview cleanup again.");
      }
      if (!expected) {
        destinations.set(target.sqlitePath, { agentId: target.agentId, files });
      }
    }
  };
}

export function verifyHistoricalMigrationArtifact(params: {
  target: SessionSqliteMigrationTargetManifest;
  move: SessionSqliteMigrationMove;
  env: NodeJS.ProcessEnv;
}): MigrationArtifact | undefined {
  const { target, move, env } = params;
  if (move.kind !== "legacy-store" && move.kind !== "transcript") {
    return undefined;
  }
  const identity = readMigrationArtifactIdentity(move.archivePath);
  const indexMove =
    move.kind === "legacy-store"
      ? move
      : uniqueRestoreMoves(target).find((item) => item.kind === "legacy-store");
  if (!indexMove) {
    return undefined;
  }
  readMigrationArtifactIdentity(indexMove.archivePath);
  const fd = fs.openSync(
    indexMove.archivePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  let index: unknown;
  try {
    index = JSON.parse(readFileDescriptorBoundedSync(fd, fs.fstatSync(fd).size).toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
  if (!isRecord(index)) {
    return undefined;
  }
  const entries =
    move.kind === "legacy-store"
      ? Object.entries(index)
      : move.sessionKey
        ? [[move.sessionKey, index[move.sessionKey]]]
        : [];
  if (move.kind === "transcript" && entries.length !== 1) {
    return undefined;
  }
  const dependencies = new Set(
    move.kind === "legacy-store"
      ? uniqueRestoreMoves(target)
          .filter((item) => item.kind === "transcript")
          .map((item) => item.sourcePath)
      : [],
  );
  const verified = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      const db = getSessionKysely(database.db);
      for (const [key, raw] of entries) {
        if (
          typeof key !== "string" ||
          !isRecord(raw) ||
          typeof raw.sessionId !== "string" ||
          !raw.sessionId.trim() ||
          typeof raw.updatedAt !== "number"
        ) {
          return false;
        }
        const sessionId = raw.sessionId;
        const row = executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("session_nodes")
            .select(["current_session_id", "entry_json"])
            .where("session_key", "=", key),
        );
        if (!row || row.current_session_id !== raw.sessionId) {
          return false;
        }
        const current: unknown = JSON.parse(row.entry_json);
        const entry = { ...raw, sessionId, updatedAt: raw.updatedAt };
        const normalized = migrateLegacySessionCreator(normalizeLegacySessionEntryDelivery(entry));
        if (
          !isRecord(current) ||
          Object.entries(normalized).some(
            ([field, value]) =>
              field !== "sessionFile" && JSON.stringify(current[field]) !== JSON.stringify(value),
          )
        ) {
          return false;
        }
        if (move.kind !== "transcript") {
          // Historical indexes can refer to transcripts published by an earlier run.
          // Reuse the producer's path contract rather than requiring same-run moves.
          for (const source of resolveLegacyTranscriptPaths(target, entry).transcriptDependencies) {
            dependencies.add(canonicalMigrationFilePath(source));
          }
          continue;
        }
        const complete = verifyTranscriptEvents(database.db, {
          path: move.archivePath,
          originalPath: move.sourcePath,
          sessionId,
        });
        if (!complete) {
          return false;
        }
      }
      return true;
    },
    { agentId: target.agentId, path: target.sqlitePath, env },
  );
  if (!verified.found || !verified.value) {
    return undefined;
  }
  return {
    identity,
    classification: "imported",
    reason: "verified-historical-import",
    dependencies: [...dependencies],
    disposal: { state: "retained" },
  };
}

export function validateLegacySessionRecords(
  target: SessionStoreTarget,
  records: readonly LegacySessionRecord[],
  report: DoctorSessionSqliteTargetReport,
  purpose: "validate" | "before-archive",
  env: NodeJS.ProcessEnv,
): boolean {
  if (purpose === "before-archive" && records.length === 0) {
    return true;
  }
  const issueCountBeforeValidation = report.issues.length;
  const validation = readOnlySqliteValidationSnapshot(target);
  if (!validation.ok) {
    report.issues.push({
      code: "sqlite_read_failed",
      message: `SQLite validation read failed: ${String(validation.error)}`,
    });
    return false;
  }
  for (const record of records) {
    validateLegacySessionRecord(record, report, validation.snapshot, purpose, env);
  }
  return report.issues.length === issueCountBeforeValidation;
}

function validateLegacySessionRecord(
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
  snapshot: ReadOnlySqliteValidationSnapshot,
  purpose: "validate" | "before-archive",
  env: NodeJS.ProcessEnv,
): void {
  const beforeArchive = purpose === "before-archive";
  // Import preserves aliases until canonical repair; standalone validation compares canonical keys.
  const normalizedKey = beforeArchive
    ? record.sessionKey
    : normalizeStoreSessionKey(record.sessionKey);
  const sqliteSessionId = record.historical
    ? snapshot.sessionKeysBySessionId.get(record.entry.sessionId) === normalizedKey
      ? record.entry.sessionId
      : undefined
    : snapshot.sessionIdsBySessionKey.get(normalizedKey);
  if (!sqliteSessionId) {
    report.issues.push({
      code: "sqlite_entry_missing",
      message: `SQLite entry is missing for ${normalizedKey}.`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  if (sqliteSessionId !== record.entry.sessionId) {
    report.issues.push({
      code: "sqlite_entry_mismatch",
      message: `SQLite sessionId ${sqliteSessionId} does not match ${record.entry.sessionId}.`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  if (!beforeArchive) {
    report.validatedEntries += 1;
  }
  const result = countTranscriptEventsForPath(record.transcriptPath);
  if (result.status === "missing") {
    if (!beforeArchive) {
      report.validatedTranscriptEvents +=
        snapshot.transcriptEventCountsBySessionId.get(record.entry.sessionId) ?? 0;
    }
    return;
  }
  if (result.status !== "ok") {
    if (
      !report.issues.some(
        (issue) => issue.code === "transcript_malformed" && issue.sessionKey === record.sessionKey,
      )
    ) {
      report.issues.push({
        code: "transcript_malformed",
        message: result.message,
        sessionKey: record.sessionKey,
      });
    }
    return;
  }
  const sqliteEvents = snapshot.transcriptEventCountsBySessionId.get(record.entry.sessionId) ?? 0;
  // Import has already verified normalized rows; standalone validation proves source containment.
  const expectedEvents = beforeArchive
    ? (record.recovery?.sqliteEvents ?? record.recovery?.events ?? result.events)
    : result.events;
  const verified =
    beforeArchive || !record.transcriptPath
      ? sqliteEvents >= expectedEvents
      : verifyCanonicalSessionTranscriptSources({
          target: report,
          mode: "contained",
          sources: [
            {
              path: record.transcriptPath,
              sessionId: record.entry.sessionId,
              originalPath: record.historical?.originalPath,
            },
          ],
          env,
        });
  if (!verified) {
    report.issues.push({
      code: "sqlite_transcript_count_mismatch",
      message: beforeArchive
        ? `SQLite transcript has ${sqliteEvents} events; verified import expects ${expectedEvents}.`
        : `SQLite transcript has ${sqliteEvents} events; source has ${result.events}, but its events are not all present with matching content. Run openclaw doctor --session-sqlite recover to import a missing suffix or identify conflicting events.`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  if (!beforeArchive) {
    report.validatedTranscriptEvents += sqliteEvents;
  }
}
