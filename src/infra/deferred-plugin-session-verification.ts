import path from "node:path";
import { isPrimarySessionTranscriptFileName } from "../config/sessions/artifacts.js";
import {
  isLegacySessionRecordOwnedByTarget,
  readLegacySessionStoreEntries,
  resolveLegacyTranscriptPaths,
  shouldFilterLegacySessionRecordsByTarget,
  type LegacySessionStoreTarget,
} from "../config/sessions/legacy-store-inspection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recoverEmptyRetainedTranscript } from "./deferred-plugin-session-empty.js";
import { readMigrationArtifactIdentity } from "./session-sqlite-migration-artifact.js";
import {
  readLegacyPrimaryTranscriptIdentity,
  readOnlySqliteDbStats,
  readOnlySqliteValidationSnapshot,
} from "./session-sqlite-migration-readers.js";
import { verifyCanonicalSessionTranscriptSources } from "./session-sqlite-transcript-verification.js";

/** A replaced database cannot inherit completed-import authority from an old inode. */
export async function verifyDeferredSessionDatabase(params: {
  cfg: OpenClawConfig;
  target: LegacySessionStoreTarget;
  sqlitePath: string;
  env: NodeJS.ProcessEnv;
  sources: Array<{ path: string; originalPath: string }>;
  requireCompleteTranscript?: boolean;
  verifiedSourcePaths?: ReadonlySet<string>;
  onEmptySource?: (sourcePath: string, reason: string) => void;
  assertCurrent: () => void;
}): Promise<void> {
  const target = { ...params.target, sqlitePath: params.sqlitePath };
  const snapshot = readOnlySqliteValidationSnapshot(target);
  const stats = readOnlySqliteDbStats(target);
  if (!snapshot.ok || !stats.ok || stats.stats.integrityCheck !== "ok") {
    throw new Error(
      `Cannot verify retained session history against ${params.sqlitePath}; inspect SQLite integrity with openclaw doctor --session-sqlite validate. Sources remain protected.`,
    );
  }
  const resolved = new Map(params.sources.map((source) => [source.originalPath, source.path]));
  const verifiedSourcePaths = params.verifiedSourcePaths ?? new Set(resolved.keys());
  const indexPath = resolved.get(path.resolve(target.storePath));
  const issues: Array<{ code: string; message: string }> = [];
  const records = (
    indexPath
      ? readLegacySessionStoreEntries(target, issues, { sourcePath: indexPath }).entries.map(
          ({ entry, sessionKey }) => ({
            entry,
            sessionKey,
            transcriptPath: resolveLegacyTranscriptPaths(target, entry, verifiedSourcePaths)
              .transcriptPath,
          }),
        )
      : []
  ).filter(
    ({ sessionKey }) =>
      !shouldFilterLegacySessionRecordsByTarget(target) ||
      isLegacySessionRecordOwnedByTarget(params.cfg, target, sessionKey),
  );
  if (issues.some((issue) => issue.code !== "entry_invalid")) {
    throw new Error(
      `Cannot verify retained session index ${target.storePath}: ${issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  for (const record of records) {
    if (
      snapshot.snapshot.sessionKeysBySessionId.get(record.entry.sessionId) !== record.sessionKey
    ) {
      throw new Error(
        `Retained session ${record.sessionKey} is not present in ${params.sqlitePath}; sources remain protected. Preserve ${record.transcriptPath ?? target.storePath} and its backups. Restore the intended session from a verified backup to ${params.sqlitePath}, then run openclaw doctor --session-sqlite recover --session-sqlite-all-agents against the same state directory. Canonical edits and deletions were not replayed.`,
      );
    }
  }
  for (const source of params.sources) {
    if (!isPrimarySessionTranscriptFileName(path.basename(source.originalPath))) {
      continue;
    }
    const sourcePath = resolved.get(source.originalPath);
    const indexed = records.filter((candidate) => candidate.transcriptPath === source.originalPath);
    if (sourcePath && readMigrationArtifactIdentity(sourcePath).size === 0) {
      const reason = await recoverEmptyRetainedTranscript({
        source,
        target,
        env: params.env,
        sessionIds: indexed.map((record) => record.entry.sessionId),
        assertCurrent: params.assertCurrent,
      });
      params.onEmptySource?.(source.path, reason);
      continue;
    }
    if (params.requireCompleteTranscript && indexed.length === 0) {
      throw new Error(`Changed retained transcript has no verified indexed owner: ${source.path}`);
    }
    const sessionIds = indexed.length
      ? indexed.map((record) => record.entry.sessionId)
      : [
          sourcePath &&
            readLegacyPrimaryTranscriptIdentity(sourcePath, source.originalPath)?.sessionId,
        ];
    if (
      !sourcePath ||
      sessionIds.some((sessionId) => {
        if (!sessionId || !snapshot.snapshot.sessionKeysBySessionId.has(sessionId)) {
          return true;
        }
        const verified = verifyCanonicalSessionTranscriptSources({
          target,
          sources: [{ path: sourcePath, originalPath: source.originalPath, sessionId }],
          env: params.env,
        });
        return (
          !verified ||
          (params.requireCompleteTranscript &&
            verified.events !== snapshot.snapshot.transcriptEventCountsBySessionId.get(sessionId))
        );
      })
    ) {
      throw new Error(
        `Retained transcript ${source.path} is not complete in ${params.sqlitePath}; source remains protected. Compare a verified database backup before retrying recovery; canonical history was not overwritten.`,
      );
    }
  }
}
