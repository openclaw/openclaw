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
import { countLegacyTranscript } from "./doctor-session-sqlite-diagnostics.js";
import type { LegacySessionRecord } from "./doctor-session-sqlite-discovery.js";
import {
  readTranscriptFingerprint,
  resolveTargetSqlitePath,
} from "./doctor-session-sqlite-readers.js";
import type {
  DoctorSessionSqliteIssue,
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
  const sourceConflicts = new Set<string>();
  const sourceVerification = {
    ...prepareSessionSourceVerification({
      ...params,
      sqlitePath: resolveTargetSqlitePath(params.target, params.env),
    }),
    allowMissingIndex: true,
    onSourceConflict: !fs.existsSync(params.target.storePath)
      ? (sourcePath: string, artifactPath = sourcePath) => {
          if (sourceConflicts.has(artifactPath)) {
            return;
          }
          sourceConflicts.add(sourcePath);
          sourceConflicts.add(artifactPath);
          issues.push({
            code: "historical_transcript_deferred",
            message: `${artifactPath}: recorded source could not be hash-verified; protected without replaying or archiving it.`,
          });
        }
      : undefined,
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
