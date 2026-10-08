/** Plans Doctor archive paths; publication and receipts remain with the migration owner. */
import fs from "node:fs";
import path from "node:path";
import {
  resolveTrajectoryPath,
  resolveTrajectoryPointerPath,
} from "../config/sessions/artifacts.js";
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import { resolveRealpathOrAbsolute as canonicalFilePath } from "../infra/boundary-path.js";
import { DeferredPluginMigrationConflictError } from "../infra/deferred-plugin-migrations.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  moveMigrationArtifact,
} from "../infra/session-sqlite-migration-artifact.js";
import {
  assertSafeSessionSqliteMigrationMove,
  assertSafeSessionSqliteMigrationDirectory,
  canonicalMigrationFilePath,
  recordPlannedMigrationMoves,
  recordCompletedMigrationMoves,
  updateMigrationManifestTarget,
  type ActiveSessionSqliteMigrationRun,
  type SessionSqliteMigrationMove,
  type SessionSqliteMigrationMoveKind,
} from "../infra/session-sqlite-migration-manifest.js";
import type { gatherLegacyArchiveCoverage } from "./doctor-session-sqlite-discovery.js";
import {
  countBlockingSessionSqliteIssues,
  type LegacyArchiveTarget,
} from "./doctor-session-sqlite-types.js";

export function planImportedTranscriptArtifactsToArchive(
  target: SessionStoreTarget,
  sessionKey: string,
  transcriptPath: string,
  reservedArchivePaths: Set<string>,
  capturedSources?: ReadonlySet<string>,
): SessionSqliteMigrationMove[] {
  const moves: SessionSqliteMigrationMove[] = [];
  const addMove = (sourcePathRaw: string, kind: SessionSqliteMigrationMoveKind) => {
    if (capturedSources && !capturedSources.has(canonicalMigrationFilePath(sourcePathRaw))) {
      return;
    }
    const move = planSessionJsonlArchiveMove({
      archiveKey: sessionKey,
      kind,
      reservedArchivePaths,
      sessionKey,
      sourcePathRaw,
      target,
    });
    reservedArchivePaths.add(move.archivePath);
    moves.push(move);
  };
  addMove(transcriptPath, "transcript");
  for (const resolvePath of [resolveTrajectoryPath, resolveTrajectoryPointerPath]) {
    const artifactPath = resolvePath(transcriptPath);
    if (artifactPath && fs.existsSync(artifactPath)) {
      addMove(artifactPath, "trajectory");
    }
  }
  return moves;
}

export function planSessionJsonlArchiveMove(params: {
  archiveKey: string;
  kind: SessionSqliteMigrationMoveKind;
  reservedArchivePaths?: ReadonlySet<string>;
  sessionKey?: string;
  sourcePathRaw: string;
  target: SessionStoreTarget;
}): SessionSqliteMigrationMove {
  const sourcePathRaw = path.resolve(params.sourcePathRaw);
  const stat = fs.lstatSync(sourcePathRaw);
  if (!stat.isFile()) {
    throw new Error("source is not a regular file");
  }
  const sourcePath = path.join(
    canonicalFilePath(path.dirname(sourcePathRaw)),
    path.basename(sourcePathRaw),
  );
  const sessionsDir = canonicalFilePath(path.dirname(path.resolve(params.target.storePath)));
  if (path.dirname(sourcePath) !== sessionsDir) {
    throw new Error(`Migration source is outside the target sessions directory: ${sourcePath}`);
  }
  const archiveDir = path.join(path.dirname(sessionsDir), "session-sqlite-import-archive");
  assertSafeSessionSqliteMigrationDirectory(archiveDir);
  fs.mkdirSync(archiveDir, { recursive: true });
  assertSafeSessionSqliteMigrationDirectory(archiveDir);
  const baseName =
    path
      .basename(params.sourcePathRaw)
      .replace(/[^A-Za-z0-9_.-]+/g, "_")
      .slice(0, 160) || "artifact";
  const keySlug = params.archiveKey.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 120) || "session";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? "" : `.${attempt}`;
    const archivePath = path.join(
      archiveDir,
      `${keySlug}.${baseName}.imported-${Date.now()}${suffix}`,
    );
    if (fs.existsSync(archivePath) || params.reservedArchivePaths?.has(archivePath)) {
      continue;
    }
    return {
      archivePath,
      kind: params.kind,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      sourcePath,
    };
  }
  throw new Error(`Could not archive ${baseName} for ${params.archiveKey}`);
}

export async function archiveImportedLegacySessionStores(
  owners: readonly LegacyArchiveTarget[],
  activeRun: ActiveSessionSqliteMigrationRun,
  coverage: ReturnType<typeof gatherLegacyArchiveCoverage>,
  assertCurrent?: () => void,
  publishSourceRemoval?: (remove: () => void, retainSource: () => void) => void,
): Promise<void> {
  const byStore = new Map<string, LegacyArchiveTarget[]>();
  for (const owner of owners) {
    const storePath = owner.target.storePath;
    byStore.set(storePath, [...(byStore.get(storePath) ?? []), owner]);
  }
  for (const [storePath, entries] of byStore) {
    assertCurrent?.();
    // A historical-only target may never have had an index; losing an admitted index is a failure.
    if (!coverage.indexIdentities.has(storePath) && !fs.existsSync(storePath)) {
      continue;
    }
    if (
      !coverage.selectedStorePaths.has(storePath) ||
      entries.some(
        ({ report }) =>
          countBlockingSessionSqliteIssues(report) > 0 ||
          report.issues.some((issue) => issue.code === "active_sqlite_transcript_jsonl"),
      )
    ) {
      continue;
    }
    const first = entries[0]!;
    let publicationPlanned = false;
    try {
      const expected = coverage.indexIdentities.get(storePath);
      if (!expected || !sameMigrationArtifact(readMigrationArtifactIdentity(storePath), expected)) {
        throw new Error("Session index changed after import; retaining the unverified original");
      }
      const move = planSessionJsonlArchiveMove({
        archiveKey: "legacy-store",
        kind: "legacy-store",
        sourcePathRaw: storePath,
        target: first.target,
      });
      const manifestTargets = activeRun.manifest.targets.filter(
        (target) => target.storePath === storePath,
      );
      const transcripts = manifestTargets.flatMap((target) =>
        target.plannedMoves.filter((item) => item.kind === "transcript"),
      );
      const complete =
        entries.every(
          ({ validated, report }) =>
            validated &&
            report.issues.every((issue) => issue.code === "historical_duplicate_settled"),
        ) && transcripts.every((item) => item.artifact?.classification !== "protected");
      const dependencies = entries
        .flatMap(({ records }) => records.flatMap((record) => record.transcriptDependencies))
        .map(canonicalMigrationFilePath);
      move.artifact = {
        identity: expected,
        classification: complete ? "imported" : "protected",
        reason: complete ? "verified-index-import" : "incomplete-index-import",
        dependencies: [...new Set(dependencies)],
        disposal: { state: "retained" },
      };
      for (const { target } of entries) {
        assertCurrent?.();
        recordPlannedMigrationMoves(activeRun, target, [move]);
        assertSafeSessionSqliteMigrationMove(move, target);
      }
      publicationPlanned = true;
      assertCurrent?.();
      await moveMigrationArtifact(
        move.sourcePath,
        move.archivePath,
        expected,
        assertCurrent
          ? () => {
              assertCurrent();
            }
          : undefined,
        publishSourceRemoval,
      );
      assertCurrent?.();
      for (const { target, report } of entries) {
        recordCompletedMigrationMoves(activeRun, target, [move]);
        report.archivedLegacyStoreFiles!.push(move.archivePath);
      }
    } catch (error) {
      if (error instanceof DeferredPluginMigrationConflictError && error.pending.length > 0) {
        break;
      }
      for (const { report, target } of entries) {
        report.issues.push({
          code: "legacy_store_archive_failed",
          message: `${storePath}: ${formatErrorMessage(error)}`,
        });
        // A recorded index plan already protects its dependencies and can reconcile on retry.
        // Earlier failures have no artifact record, so retain that failure on the owner instead.
        if (!publicationPlanned) {
          assertCurrent?.();
          updateMigrationManifestTarget(activeRun, target, report.issues);
        }
      }
    }
  }
}
