import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { importSqliteSessionRowsBatch } from "../config/sessions/session-accessor.sqlite-import.js";
import type { SessionStoreTarget as ResolvedSessionStoreTarget } from "../config/sessions/targets.js";
import { formatErrorMessage } from "../infra/errors.js";
import { prepareLegacyAcpMigrationSource } from "../infra/legacy-acp-migration-source.js";
import {
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  statMigrationPath,
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
import { verifyCanonicalSessionTranscriptSources } from "../infra/session-sqlite-transcript-verification.js";
import type { LegacySessionRecord } from "./doctor-session-sqlite-discovery.js";
import type { collectRecoveryInventory } from "./doctor-session-sqlite-recovery-inventory.js";
import type { DoctorSessionSqliteTargetReport } from "./doctor-session-sqlite-types.js";
import { normalizePersistedSessionEntryShape } from "./doctor/shared/session-entry-shape.js";

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
    const recoveryHistoryUnverified = Boolean(
      recoveryInventory?.report.artifacts.some((artifact) =>
        ["unreadable-manifest", "manifest-directory-alias"].includes(artifact.reason),
      ),
    );
    let assertRestoredIndexCurrent: (() => void) | undefined;
    try {
      if (!recoveryHistoryUnverified) {
        assertRestoredIndexCurrent = prepareRestoredSessionIndex({
          target,
          env,
          expectedIndexIdentity,
          recoveryInventory,
        });
      }
    } catch (error) {
      report.issues.push({
        code: "legacy_import_deferred",
        message: `${formatErrorMessage(error)}. Originals retained; preserve the files and receipts, restore verified recovery evidence, then rerun openclaw doctor --fix.`,
      });
      return;
    }
    const importedTranscriptSources = new Set<string>();
    const existingSnapshot = readOnlySqliteValidationSnapshot(target);
    if (!existingSnapshot.ok) {
      report.issues.push({
        code: "legacy_import_deferred",
        message: `Cannot verify the destination for ${target.storePath}: ${formatErrorMessage(existingSnapshot.error)}. Originals retained; repair the named SQLite destination before retrying openclaw doctor --fix.`,
      });
      return;
    }
    for (let offset = 0; offset < records.length; offset += SESSION_IMPORT_BATCH_SIZE) {
      const pending = records
        .slice(offset, offset + SESSION_IMPORT_BATCH_SIZE)
        .flatMap((record) => {
          // Unreadable history cannot authorize replay of a current node's metadata or generation.
          record.preserveCurrentSession ||=
            recoveryHistoryUnverified || Boolean(assertRestoredIndexCurrent);
          try {
            const prepared = prepareLegacySessionImport(
              target,
              record,
              report,
              importedTranscriptSources,
              existingSnapshot.snapshot,
              env,
              recoveryHistoryUnverified,
            );
            return prepared ? [{ ...prepared, params: { ...prepared.params, env }, record }] : [];
          } catch (error) {
            report.issues.push({
              code: "legacy_import_deferred",
              sessionKey: record.sessionKey,
              message: `${record.transcriptPath ?? target.storePath}: ${formatErrorMessage(error)}. Original retained; verify this source against a backup and rerun openclaw doctor --fix.`,
            });
            return [];
          }
        });
      const imported = await importSqliteSessionRowsBatch(
        pending.map((entry, index) => ({
          ...entry.params,
          ...(index === 0 && assertRestoredIndexCurrent
            ? { beforePersistentApply: assertRestoredIndexCurrent }
            : {}),
        })),
      );
      for (const [index, result] of imported.entries()) {
        const record = pending[index]?.record;
        const recovery = pending[index]?.recovery ?? result.recovery;
        if (record && recovery) {
          record.recovery = recovery;
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

function prepareRestoredSessionIndex(
  params: Parameters<typeof importLegacySessionRecords>[0],
): (() => void) | undefined {
  const { expectedIndexIdentity, recoveryInventory, target } = params;
  if (!expectedIndexIdentity || !recoveryInventory) {
    return undefined;
  }
  const storePath = canonicalMigrationFilePath(target.storePath);
  const sqlitePath = resolveTargetSqlitePath(target, params.env);
  const evidence = new Map<string, MigrationArtifactIdentity>();
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
        // Pre-artifact receipts identify paths, not the file now occupying them.
        // A distinct surviving archive proves a new index; otherwise preserve current nodes.
        assertSafeSessionSqliteMigrationMove(ref.move, ref.target);
        if (statMigrationPath(ref.move.archivePath)) {
          const archiveIdentity = readMigrationArtifactIdentity(ref.move.archivePath);
          if (
            archiveIdentity.size !== expectedIndexIdentity.size ||
            archiveIdentity.sha256 !== expectedIndexIdentity.sha256
          ) {
            continue;
          }
          evidence.set(ref.move.archivePath, archiveIdentity);
        }
      }
      // A newly created legacy index is a different source, even at the same path.
      if (
        artifact &&
        (artifact.identity.dev !== expectedIndexIdentity.dev ||
          artifact.identity.ino !== expectedIndexIdentity.ino)
      ) {
        continue;
      }
      // Shared originals have several owners; explicit restore admission also covers
      // custom stores outside automatic cleanup discovery.
      const selectedOwner = filterRestoreManifestTargets(ref.run.manifest, [
        { agentId: target.agentId, storePath, sqlitePath },
      ]).includes(ref.target);
      if (
        (artifact &&
          (!sameMigrationArtifact(artifact.identity, expectedIndexIdentity) ||
            !ref.consumedByRestore ||
            artifact.disposal.state !== "retained")) ||
        ref.target.storePath !== storePath ||
        (ref.target.agentId === target.agentId && !selectedOwner)
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
      evidence.set(ref.run.manifestPath, identity);
      hasSelectedOwner ||= selectedOwner;
    }
  }
  if (evidence.size === 0) {
    return undefined;
  }
  if (!hasSelectedOwner) {
    throw new Error(`Restored session index evidence cannot be verified: ${storePath}`);
  }
  // A per-file restore can succeed during a partial or failed run. It proves provenance,
  // not permission to replace the current node; the import transaction preserves that owner.
  const assertCurrent = () => {
    for (const filePath of [storePath, sqlitePath, ...evidence.keys()]) {
      if (hasSymbolicLinkInDirectoryPath(path.dirname(filePath))) {
        throw new Error(`Session restore path changed: ${filePath}`);
      }
    }
    for (const [filePath, identity] of [[storePath, expectedIndexIdentity] as const, ...evidence]) {
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
  existingSnapshot: ReadOnlySqliteValidationSnapshot,
  env: NodeJS.ProcessEnv,
  recoveryHistoryUnverified: boolean,
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
  const currentOwner = existingSnapshot.sessionKeysBySessionId.get(record.entry.sessionId);
  if (record.preserveCurrentSession && currentOwner && currentOwner !== record.sessionKey) {
    throw new Error(
      `Historical transcript ${record.entry.sessionId} already belongs to ${currentOwner}`,
    );
  }
  if (
    recoveryHistoryUnverified &&
    result.status === "malformed" &&
    (existingSnapshot.transcriptEventCountsBySessionId.get(record.entry.sessionId) ?? 0) > 0
  ) {
    throw new Error(result.message);
  }
  const transcriptMtimeMs = readLegacyTranscriptMtimeMs(record);
  const normalizedEntry = normalizePersistedSessionEntryShape(record.entry, {
    sessionKey: record.sessionKey,
  });
  const params = {
    historicalOnly: Boolean(record.historical || record.preserveCurrentSession),
    allowMalformedRowRepair: true,
    repairLegacyTranscript: true,
    agentId: target.agentId,
    entry: { ...(normalizedEntry ?? record.entry), sessionId: record.entry.sessionId },
    ...(!record.historical && normalizedEntry?.acp
      ? {
          legacyAcpMigrationSource: prepareLegacyAcpMigrationSource({
            sourcePath: target.storePath,
            sourceSessionKey: record.sessionKey,
            sessionId: normalizedEntry.sessionId,
            lifecycleRevision: normalizedEntry.lifecycleRevision,
            meta: normalizedEntry.acp,
          }),
        }
      : {}),
    preserveExactStoredKey: true,
    sessionKey: record.sessionKey,
    storePath: target.sqlitePath ?? target.storePath,
  };
  let recovery: LegacySessionRecord["recovery"];
  if (result.status === "missing") {
    if (existingSnapshot.sessionIdsBySessionKey.get(record.sessionKey) === record.entry.sessionId) {
      report.validatedEntries += 1;
      report.validatedTranscriptEvents +=
        existingSnapshot.transcriptEventCountsBySessionId.get(record.entry.sessionId) ?? 0;
      return undefined;
    }
    return {
      issue: {
        code: "transcript_missing",
        message: `Transcript file is missing: ${record.transcriptPath}`,
        sessionKey: record.sessionKey,
      },
      params,
      recovery,
    };
  }
  if (
    result.status === "ok" &&
    transcriptFingerprint &&
    record.transcriptPath &&
    (existingSnapshot.transcriptEventCountsBySessionId.get(record.entry.sessionId) ?? 0) > 0
  ) {
    try {
      const verified = verifyCanonicalSessionTranscriptSources({
        target: { ...target, sqlitePath: report.sqlitePath },
        sources: [
          {
            path: record.transcriptPath,
            sessionId: record.entry.sessionId,
            originalPath: record.historical?.originalPath ?? record.transcriptPath,
          },
        ],
        env,
        mode: "appendable",
      });
      if (!verified) {
        throw new Error(
          "Missing history requires legacy format or branch repair before it can be appended",
        );
      }
      if (verified.missingEvents === 0) {
        recovery = {
          complete: true,
          repaired: false,
          events: verified.events,
          sqliteEvents: verified.sqliteEvents,
        };
      }
    } catch (error) {
      report.issues.push({
        code: recoveryHistoryUnverified
          ? "legacy_import_deferred"
          : "sqlite_transcript_count_mismatch",
        sessionKey: record.sessionKey,
        message: `${record.transcriptPath}: ${formatErrorMessage(error)}. Original retained. Compare the named events with a verified backup, restore a corrected JSONL at this path, then rerun openclaw doctor --session-sqlite recover.`,
      });
      return undefined;
    }
  }
  if (transcriptSourceKey) {
    importedTranscriptSources.add(transcriptSourceKey);
  }
  return {
    recovery,
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
