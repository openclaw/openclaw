import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  prepareSessionSourceVerification,
  readDeferredPluginSessionImport,
  rebuildDeferredPluginSessionSourceIndex,
  resolveVerifiedSessionSource,
  type DeferredPluginSessionImport,
} from "../infra/deferred-plugin-session-sources.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  moveMigrationArtifact,
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  type MigrationArtifactIdentity,
} from "../infra/session-sqlite-migration-artifact.js";
import type { DoctorSessionSqliteIssue } from "../infra/session-sqlite-migration-issues.js";
import {
  canonicalMigrationFilePath,
  createSessionSqliteMigrationRun,
  recordPlannedMigrationMoves,
  recordCompletedMigrationMoves,
  updateMigrationManifestTarget,
  writeSessionSqliteMigrationManifest,
  type ActiveSessionSqliteMigrationRun,
  type SessionSqliteMigrationTargetInput,
} from "../infra/session-sqlite-migration-manifest.js";
import {
  readTranscriptFingerprint,
  resolveTargetSqlitePath,
} from "../infra/session-sqlite-migration-readers.js";
import { planSessionJsonlArchiveMove } from "./doctor-session-sqlite-archive.js";
import { countLegacyTranscript } from "./doctor-session-sqlite-diagnostics.js";
import type { LegacySessionRecord } from "./doctor-session-sqlite-discovery.js";
import type {
  DoctorSessionSqliteMode,
  DoctorSessionSqliteTargetReport,
} from "./doctor-session-sqlite-types.js";

/** Receipt recovery belongs to offline Doctor; canonical session data is never replayed. */
export function prepareRetainedSessionImport(
  params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    target: SessionStoreTarget;
    mode: DoctorSessionSqliteMode;
  },
  issues: DoctorSessionSqliteIssue[],
) {
  const isSqliteStore = params.target.storePath.endsWith(".sqlite");
  let retainedImport: DeferredPluginSessionImport | undefined;
  const sourceConflicts = new Map<string, string>();
  const sourceVerification = {
    ...prepareSessionSourceVerification({
      ...params,
      sqlitePath: resolveTargetSqlitePath(params.target, params.env),
    }),
    allowMissingIndex: true,
    onSourceConflict: (sourcePath: string, artifactPath = sourcePath, error?: unknown) => {
      if (sourceConflicts.has(artifactPath)) {
        return;
      }
      const reason =
        error === undefined
          ? "Retained plugin input no longer matches its verified source."
          : formatErrorMessage(error);
      sourceConflicts.set(sourcePath, reason);
      sourceConflicts.set(artifactPath, reason);
      issues.push({
        code: fs.existsSync(params.target.storePath)
          ? "retained_plugin_source_conflict"
          : "historical_transcript_deferred",
        message: `${artifactPath}: ${reason} Canonical SQLite sessions remain authoritative. Run openclaw doctor --fix to preserve the conflicting input in the migration archive.`,
      });
    },
  };
  if (!isSqliteStore) {
    try {
      if (
        (params.mode === "import" || params.mode === "recover") &&
        rebuildDeferredPluginSessionSourceIndex(sourceVerification)
      ) {
        issues.push({
          code: "retained_plugin_source_index_rebuilt",
          message: `Rebuilt the verified source index and database binding from the deferred import receipt: ${params.target.storePath}. Canonical SQLite sessions were not replayed.`,
        });
      }
      retainedImport = readDeferredPluginSessionImport(sourceVerification);
    } catch (error) {
      issues.push({ code: "retained_plugin_source_conflict", message: formatErrorMessage(error) });
      return undefined;
    }
  }
  const retainedIndex = retainedImport?.sources.find(
    (source) => source.path === path.resolve(params.target.storePath),
  );
  const retainedIndexPath =
    retainedIndex &&
    resolveVerifiedSessionSource(
      retainedIndex,
      sourceVerification.resolvedTarget,
      params.env,
      sourceVerification.verification,
    );
  return { retainedImport, sourceConflicts, sourceVerification, retainedIndexPath };
}

/** Preserve unverifiable plugin inputs through the existing reversible archive lifecycle. */
export async function archiveConflictingRetainedSessionSources(
  params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    target: SessionStoreTarget;
    activeRun?: ActiveSessionSqliteMigrationRun;
    protectedPaths?: ReadonlySet<string>;
    expectedIndexIdentity?: MigrationArtifactIdentity;
    targets?: readonly SessionSqliteMigrationTargetInput[];
  },
  sourceConflicts: Map<string, string>,
  report: DoctorSessionSqliteTargetReport,
): Promise<void> {
  const target = {
    ...params.target,
    sqlitePath: resolveTargetSqlitePath(params.target, params.env),
  };
  const conflicts = [...sourceConflicts].filter(
    ([source]) =>
      !params.protectedPaths?.has(canonicalMigrationFilePath(source)) &&
      fs.existsSync(source) &&
      path.dirname(source) === path.dirname(target.storePath),
  );
  if (!conflicts.length) {
    return;
  }
  const run = params.activeRun ?? createSessionSqliteMigrationRun(params.env, [target]);
  const targets = params.targets ?? [target];
  let indexPath = target.storePath;
  const indexIdentity =
    params.expectedIndexIdentity ??
    (!params.activeRun && fs.existsSync(indexPath)
      ? readMigrationArtifactIdentity(indexPath)
      : undefined);
  const assertIndexCurrent = () => {
    if (
      (indexPath !== target.storePath && fs.existsSync(target.storePath)) ||
      (indexIdentity
        ? !sameMigrationArtifact(readMigrationArtifactIdentity(indexPath), indexIdentity)
        : fs.existsSync(indexPath))
    ) {
      throw new Error(
        "Session index changed after owner discovery; original retained for a fresh Doctor pass.",
      );
    }
  };
  for (const [source, reason] of conflicts) {
    try {
      assertIndexCurrent();
      const move = planSessionJsonlArchiveMove({
        target,
        sourcePathRaw: source,
        baseNameRaw: path.basename(source),
        archiveKey: "retained-plugin-conflict",
        kind: source === target.storePath ? "legacy-store" : "transcript",
      });
      move.artifact = {
        identity:
          move.kind === "legacy-store" && indexIdentity
            ? indexIdentity
            : readMigrationArtifactIdentity(source),
        classification: "protected",
        reason,
        dependencies: [],
        disposal: { state: "retained" },
      };
      for (const owner of targets) {
        recordPlannedMigrationMoves(run, owner, [move]);
      }
      await moveMigrationArtifact(
        move.sourcePath,
        move.archivePath,
        move.artifact.identity,
        undefined,
        (remove, retain) => {
          if (move.kind !== "legacy-store") {
            try {
              assertIndexCurrent();
            } catch (error) {
              retain();
              throw error;
            }
          }
          remove();
        },
      );
      for (const owner of targets) {
        recordCompletedMigrationMoves(run, owner, [move]);
      }
      if (move.kind === "legacy-store") {
        indexPath = move.archivePath;
      }
      sourceConflicts.set(move.archivePath, reason);
      (move.kind === "legacy-store"
        ? (report.archivedLegacyStoreFiles ??= [])
        : report.archivedTranscriptFiles
      ).push(move.archivePath);
      report.issues.push({
        code: "retained_plugin_source_conflict",
        message: `${source}: ${reason} Preserved at ${move.archivePath}; canonical SQLite sessions were not replayed.`,
      });
    } catch (error) {
      report.issues.push({
        code: "retained_plugin_source_conflict",
        message: `${source}: could not archive retained input: ${formatErrorMessage(error)}. Original remains protected.`,
      });
    }
  }
  updateMigrationManifestTarget(run, target, report.issues);
  if (!params.activeRun) {
    run.manifest.completedAt = new Date().toISOString();
    writeSessionSqliteMigrationManifest(run);
  }
}

/** Historical discovery yields; verify the receipt again before counting or authorizing archival. */
export function countRetainedSessionSources(
  retained: NonNullable<ReturnType<typeof prepareRetainedSessionImport>>,
  records: readonly LegacySessionRecord[],
  report: DoctorSessionSqliteTargetReport,
): void {
  const { retainedImport, retainedIndexPath, sourceVerification, sourceConflicts } = retained;
  if (!retainedImport) {
    return;
  }
  if (!retainedIndexPath) {
    sourceVerification.verification.clear();
    if (!isDeepStrictEqual(readDeferredPluginSessionImport(sourceVerification), retainedImport)) {
      throw new Error("Verified retained session import receipt changed during discovery.");
    }
  }
  const verifiedSources = new Map(retainedImport.sources.map((source) => [source.path, source]));
  for (const record of records) {
    if (record.transcriptPath && sourceConflicts.has(record.transcriptPath)) {
      continue;
    }
    const source =
      record.transcriptPath && verifiedSources.get(path.resolve(record.transcriptPath));
    if (record.transcriptPath && !source) {
      report.issues.push({
        code: "transcript_missing",
        message: `Transcript file is missing: ${record.transcriptPath}`,
        sessionKey: record.sessionKey,
      });
    } else if (record.transcriptPath && source) {
      if (fs.existsSync(record.transcriptPath)) {
        record.sourceFingerprint = readTranscriptFingerprint(record.transcriptPath);
      }
      const transcriptPath = resolveVerifiedSessionSource(
        source,
        sourceVerification.resolvedTarget,
        sourceVerification.env,
        sourceVerification.verification,
      );
      if (!transcriptPath) {
        throw new Error(`Retained session migration source changed: ${record.transcriptPath}`);
      }
      // A receipt prevents replay; it does not certify the malformed suffix as imported.
      countLegacyTranscript({ ...record, transcriptPath }, report);
      record.recovery = {
        complete: !report.issues.some(
          (issue) =>
            issue.code === "transcript_malformed" && issue.sessionKey === record.sessionKey,
        ),
        repaired: false,
        events: 0,
      };
    }
  }
}
