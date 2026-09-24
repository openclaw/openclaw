import fs from "node:fs";
import { setImmediate } from "node:timers/promises";
import { importSqliteSessionRowsBatch } from "../config/sessions/session-accessor.sqlite-import.js";
import { normalizePersistedSessionEntryShape } from "../config/sessions/store-entry-shape.js";
import type { SessionStoreTarget as ResolvedSessionStoreTarget } from "../config/sessions/targets.js";
import { formatErrorMessage } from "../infra/errors.js";
import { prepareLegacyAcpMigrationSource } from "../infra/legacy-acp-migration-source.js";
import {
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
} from "../infra/session-sqlite-migration-artifact.js";
import {
  updateMigrationManifestTarget,
  type ActiveSessionSqliteMigrationRun,
} from "../infra/session-sqlite-migration-manifest.js";
import {
  countTranscriptEventsForPath,
  createTranscriptEventReader,
  readOnlySqliteValidationSnapshot,
  readTranscriptFingerprint,
  type ReadOnlySqliteValidationSnapshot,
} from "../infra/session-sqlite-migration-readers.js";
import type { LegacySessionRecord } from "./doctor-session-sqlite-discovery.js";
import type { DoctorSessionSqliteTargetReport } from "./doctor-session-sqlite-types.js";

type SessionStoreTarget = ResolvedSessionStoreTarget & { sqlitePath?: string };
const SESSION_IMPORT_BATCH_SIZE = 256;

export async function importLegacySessionRecords(
  { target, env }: { target: SessionStoreTarget; env: NodeJS.ProcessEnv },
  records: readonly LegacySessionRecord[],
  report: DoctorSessionSqliteTargetReport,
  activeRun?: ActiveSessionSqliteMigrationRun,
): Promise<void> {
  if (records.length === 0) {
    return;
  }
  try {
    const importedTranscriptSources = new Set<string>();
    const existingSnapshot = readOnlySqliteValidationSnapshot(target);
    for (let offset = 0; offset < records.length; offset += SESSION_IMPORT_BATCH_SIZE) {
      const pending = records
        .slice(offset, offset + SESSION_IMPORT_BATCH_SIZE)
        .flatMap((record) => {
          const prepared = prepareLegacySessionImport(
            target,
            record,
            report,
            importedTranscriptSources,
            existingSnapshot.ok ? existingSnapshot.snapshot : undefined,
          );
          return prepared ? [{ ...prepared, params: { ...prepared.params, env }, record }] : [];
        });
      const imported = await importSqliteSessionRowsBatch(pending.map((entry) => entry.params));
      for (const [index, result] of imported.entries()) {
        const record = pending[index]?.record;
        if (record && result.recovery) {
          record.recovery = result.recovery;
        }
      }
      report.importedEntries += imported.length;
      report.importedTranscriptEvents += imported.reduce(
        (total, result) => total + result.transcriptEvents,
        0,
      );
      report.issues.push(...pending.flatMap((entry) => (entry.issue ? [entry.issue] : [])));
      await setImmediate();
    }
  } catch (error) {
    const failures = [error];
    report.issues.push({ code: "sqlite_import_failed", message: formatErrorMessage(error) });
    if (activeRun) {
      activeRun.manifest.failedAt = new Date().toISOString();
      try {
        updateMigrationManifestTarget(activeRun, report, report.issues);
      } catch (recordError) {
        failures.push(recordError);
      }
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `${formatErrorMessage(error)}; could not record session SQLite migration failure: ${formatErrorMessage(failures[1])}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function prepareLegacySessionImport(
  target: SessionStoreTarget,
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
  importedTranscriptSources: Set<string>,
  existingSnapshot: ReadOnlySqliteValidationSnapshot | undefined,
) {
  if (
    record.historical &&
    record.transcriptPath &&
    !sameMigrationArtifact(
      record.historical.identity,
      readMigrationArtifactIdentity(record.transcriptPath),
    )
  ) {
    report.issues.push({
      code: "historical_transcript_deferred",
      sessionKey: record.sessionKey,
      message: `${record.historical.originalPath}: source changed after discovery; retained without importing`,
    });
    return undefined;
  }
  const transcriptSourceKey = record.transcriptPath
    ? `${record.entry.sessionId}\0${record.transcriptPath}`
    : undefined;
  const transcriptFingerprint =
    transcriptSourceKey !== undefined &&
    !importedTranscriptSources.has(transcriptSourceKey) &&
    record.transcriptPath &&
    fs.existsSync(record.transcriptPath)
      ? readTranscriptFingerprint(record.transcriptPath)
      : undefined;
  record.sourceFingerprint = transcriptFingerprint;
  const result = countTranscriptEventsForPath(record.transcriptPath);
  const transcriptMtimeMs = readLegacyTranscriptMtimeMs(record);
  const acpEntry = !record.historical
    ? normalizePersistedSessionEntryShape(record.entry, { sessionKey: record.sessionKey })
    : undefined;
  const params = {
    historicalOnly: Boolean(record.historical),
    allowMalformedRowRepair: true,
    repairLegacyTranscript: true,
    agentId: target.agentId,
    entry: record.entry,
    ...(acpEntry?.acp
      ? {
          legacyAcpMigrationSource: prepareLegacyAcpMigrationSource({
            sourcePath: target.storePath,
            sourceSessionKey: record.sessionKey,
            sessionId: acpEntry.sessionId,
            lifecycleRevision: acpEntry.lifecycleRevision,
            meta: acpEntry.acp,
          }),
        }
      : {}),
    preserveExactStoredKey: true,
    sessionKey: record.sessionKey,
    storePath: target.sqlitePath ?? target.storePath,
  };
  if (result.status === "missing") {
    if (markAlreadyMigratedTranscript(record, report, existingSnapshot)) {
      return undefined;
    }
    return {
      issue: {
        code: "transcript_missing",
        message: `Transcript file is missing: ${record.transcriptPath}`,
        sessionKey: record.sessionKey,
      },
      params,
    };
  }
  if (transcriptSourceKey) {
    importedTranscriptSources.add(transcriptSourceKey);
  }
  return {
    ...(result.status === "malformed"
      ? {
          issue: {
            code: "transcript_malformed" as const,
            message: result.message,
            sessionKey: record.sessionKey,
          },
        }
      : {}),
    params: {
      ...params,
      ...(record.transcriptPath && transcriptFingerprint
        ? {
            readTranscriptEvents: createTranscriptEventReader(
              record.transcriptPath,
              record.entry.sessionId,
              result.status === "malformed",
              transcriptFingerprint,
              record.historical?.originalPath ?? record.transcriptPath,
            ),
          }
        : {}),
      ...(transcriptMtimeMs !== undefined ? { transcriptMtimeMs } : {}),
    },
  };
}

function markAlreadyMigratedTranscript(
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
  snapshot: ReadOnlySqliteValidationSnapshot | undefined,
): boolean {
  const migratedEvents = countAlreadyMigratedTranscriptEventsForImport(snapshot, record);
  if (migratedEvents === undefined) {
    return false;
  }
  report.validatedEntries += 1;
  report.validatedTranscriptEvents += migratedEvents;
  return true;
}

function countAlreadyMigratedTranscriptEventsForImport(
  snapshot: ReadOnlySqliteValidationSnapshot | undefined,
  record: LegacySessionRecord,
): number | undefined {
  if (!snapshot) {
    return undefined;
  }
  const normalizedKey = record.sessionKey;
  if (snapshot.sessionIdsBySessionKey.get(normalizedKey) !== record.entry.sessionId) {
    return undefined;
  }
  return snapshot.transcriptEventCountsBySessionId.get(record.entry.sessionId) ?? 0;
}

function readLegacyTranscriptMtimeMs(record: LegacySessionRecord): number | undefined {
  if (!record.transcriptPath) {
    return undefined;
  }
  try {
    const mtimeMs = Math.floor(fs.statSync(record.transcriptPath).mtimeMs);
    return Number.isFinite(mtimeMs) && mtimeMs >= 0 ? mtimeMs : undefined;
  } catch {
    return undefined;
  }
}
