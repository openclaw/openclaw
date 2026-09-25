import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { importSqliteSessionRowsBatch } from "../config/sessions/session-accessor.sqlite-import.js";
import { normalizePersistedSessionEntryShape } from "../config/sessions/store-entry-shape.js";
import type { SessionStoreTarget as ResolvedSessionStoreTarget } from "../config/sessions/targets.js";
import { formatErrorMessage } from "../infra/errors.js";
import { prepareLegacyAcpMigrationSource } from "../infra/legacy-acp-migration-source.js";
import {
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  type MigrationArtifactIdentity,
} from "../infra/session-sqlite-migration-artifact.js";
import {
  assertSafeSessionSqliteMigrationMove,
  canonicalMigrationFilePath,
  filterRestoreManifestTargets,
  hasSymbolicLinkInDirectoryPath,
  migrationMoveKey,
  readSessionSqliteMigrationManifest,
  updateMigrationManifestTarget,
  type ActiveSessionSqliteMigrationRun,
} from "../infra/session-sqlite-migration-manifest.js";
import {
  countTranscriptEventsForPath,
  createTranscriptEventReader,
  readOnlySqliteValidationSnapshot,
  readTranscriptFingerprint,
  resolveTargetSqlitePath,
  type ReadOnlySqliteValidationSnapshot,
} from "../infra/session-sqlite-migration-readers.js";
import type { LegacySessionRecord } from "./doctor-session-sqlite-discovery.js";
import type { collectRecoveryInventory } from "./doctor-session-sqlite-recovery-inventory.js";
import type { DoctorSessionSqliteTargetReport } from "./doctor-session-sqlite-types.js";

type SessionStoreTarget = ResolvedSessionStoreTarget & { sqlitePath?: string };
const SESSION_IMPORT_BATCH_SIZE = 256;

export async function importLegacySessionRecords(
  {
    target,
    env,
    expectedIndexIdentity,
    recoveryInventory,
  }: {
    target: SessionStoreTarget;
    env: NodeJS.ProcessEnv;
    expectedIndexIdentity?: MigrationArtifactIdentity;
    recoveryInventory?: ReturnType<typeof collectRecoveryInventory>;
  },
  records: readonly LegacySessionRecord[],
  report: DoctorSessionSqliteTargetReport,
  activeRun?: ActiveSessionSqliteMigrationRun,
): Promise<void> {
  if (records.length === 0) {
    return;
  }
  try {
    const requireEmptyStore = Boolean(
      recoveryInventory?.report.artifacts.some((artifact) =>
        ["unreadable-manifest", "manifest-directory-alias"].includes(artifact.reason),
      ),
    );
    const assertRestoredIndexCurrent = requireEmptyStore
      ? undefined
      : prepareRestoredSessionIndex({ target, env, expectedIndexIdentity, recoveryInventory });
    // The exceptional empty-store admission and every row must share one transaction.
    const batchSize = requireEmptyStore ? records.length : SESSION_IMPORT_BATCH_SIZE;
    const importedTranscriptSources = new Set<string>();
    const existingSnapshot = readOnlySqliteValidationSnapshot(target);
    for (let offset = 0; offset < records.length; offset += batchSize) {
      const pending = records.slice(offset, offset + batchSize).flatMap((record) => {
        const prepared = prepareLegacySessionImport(
          target,
          record,
          report,
          importedTranscriptSources,
          existingSnapshot.ok ? existingSnapshot.snapshot : undefined,
        );
        return prepared ? [{ ...prepared, params: { ...prepared.params, env }, record }] : [];
      });
      const imported = await importSqliteSessionRowsBatch(
        pending.map((entry, index) => ({
          ...entry.params,
          requireEmptyStore,
          historicalOnly: entry.params.historicalOnly || Boolean(assertRestoredIndexCurrent),
          ...(index === 0 && assertRestoredIndexCurrent
            ? { beforePersistentApply: assertRestoredIndexCurrent }
            : {}),
        })),
      );
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

function prepareRestoredSessionIndex(params: {
  target: SessionStoreTarget;
  env: NodeJS.ProcessEnv;
  expectedIndexIdentity?: MigrationArtifactIdentity;
  recoveryInventory?: ReturnType<typeof collectRecoveryInventory>;
}): (() => void) | undefined {
  const { expectedIndexIdentity, recoveryInventory, target } = params;
  if (!expectedIndexIdentity || !recoveryInventory) {
    return undefined;
  }
  const storePath = canonicalMigrationFilePath(target.storePath);
  const sqlitePath = resolveTargetSqlitePath(target, params.env);
  const receipts = new Map<string, MigrationArtifactIdentity>();
  let hasSelectedOwner = false;
  for (const refs of recoveryInventory.references.values()) {
    for (const ref of refs) {
      if (
        ref.move.kind !== "legacy-store" ||
        ref.move.sourcePath !== storePath ||
        (!ref.consumedByRestore &&
          !ref.run.manifest.restore?.restoredFiles.includes(storePath) &&
          !ref.target.completedMoves.some(
            (move) => migrationMoveKey(move) === migrationMoveKey(ref.move),
          ))
      ) {
        continue;
      }
      const artifact = ref.move.artifact;
      if (!artifact) {
        throw new Error(`Restored session index has no recorded identity: ${storePath}`);
      }
      // A newly created legacy index is a different source, even at the same path.
      if (
        artifact.identity.dev !== expectedIndexIdentity.dev ||
        artifact.identity.ino !== expectedIndexIdentity.ino
      ) {
        continue;
      }
      // Shared originals have several owners; explicit restore admission also covers
      // custom stores outside automatic cleanup discovery.
      const selectedOwner = filterRestoreManifestTargets(ref.run.manifest, [
        { agentId: target.agentId, storePath, sqlitePath },
      ]).includes(ref.target);
      if (
        !sameMigrationArtifact(artifact.identity, expectedIndexIdentity) ||
        !ref.consumedByRestore ||
        ref.target.storePath !== storePath ||
        (ref.target.agentId === target.agentId && !selectedOwner) ||
        artifact.disposal.state !== "retained"
      ) {
        throw new Error(`Restored session index evidence cannot be verified: ${storePath}`);
      }
      assertSafeSessionSqliteMigrationMove(ref.move, ref.target);
      const identity = readMigrationArtifactIdentity(ref.run.manifestPath);
      if (
        JSON.stringify(readSessionSqliteMigrationManifest(ref.run.manifestPath)) !==
          JSON.stringify(ref.run.manifest) ||
        !sameMigrationArtifact(identity, readMigrationArtifactIdentity(ref.run.manifestPath))
      ) {
        throw new Error(`Session restore receipt changed: ${ref.run.manifestPath}`);
      }
      receipts.set(ref.run.manifestPath, identity);
      hasSelectedOwner ||= selectedOwner;
    }
  }
  if (receipts.size === 0) {
    return undefined;
  }
  if (!hasSelectedOwner) {
    throw new Error(`Restored session index evidence cannot be verified: ${storePath}`);
  }
  // A per-file restore can succeed during a partial or failed run. It proves provenance,
  // not permission to replace the current node; the import transaction preserves that owner.
  const assertCurrent = () => {
    for (const filePath of [storePath, sqlitePath, ...receipts.keys()]) {
      if (hasSymbolicLinkInDirectoryPath(path.dirname(filePath))) {
        throw new Error(`Session restore path changed: ${filePath}`);
      }
    }
    for (const [filePath, identity] of [[storePath, expectedIndexIdentity] as const, ...receipts]) {
      if (!sameMigrationArtifact(identity, readMigrationArtifactIdentity(filePath))) {
        throw new Error(`Session restore source or receipt changed: ${filePath}`);
      }
    }
  };
  assertCurrent();
  return assertCurrent;
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
