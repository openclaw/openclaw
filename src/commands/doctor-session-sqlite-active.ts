import { importSqliteSessionRowsBatch } from "../config/sessions/session-accessor.sqlite-import.js";
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import { formatErrorMessage } from "../infra/errors.js";
import { readMigrationArtifactIdentity } from "../infra/session-sqlite-migration-artifact.js";
import { canonicalMigrationFilePath } from "../infra/session-sqlite-migration-manifest.js";
import {
  createTranscriptEventReader,
  readLegacyPrimaryTranscriptIdentity,
  readTranscriptFingerprint,
  resolveTargetSqlitePath,
} from "../infra/session-sqlite-migration-readers.js";
import { verifyCanonicalSessionTranscriptSources } from "../infra/session-sqlite-transcript-verification.js";
import { readActiveSqliteTranscriptFiles } from "./doctor-session-sqlite-diagnostics.js";
import type { LegacySessionRecord } from "./doctor-session-sqlite-discovery.js";
import type { DoctorSessionSqliteTargetReport } from "./doctor-session-sqlite-types.js";

/** Old imports can leave active originals outside a later plugin receipt. Never replay their index. */
export async function prepareActiveSqliteTranscriptSettlement(params: {
  target: SessionStoreTarget;
  env: NodeJS.ProcessEnv;
  excludedPaths: ReadonlySet<string>;
  report: DoctorSessionSqliteTargetReport;
}): Promise<LegacySessionRecord[]> {
  const records: LegacySessionRecord[] = [];
  const target = {
    ...params.target,
    sqlitePath: resolveTargetSqlitePath(params.target, params.env),
  };
  let sourcesToSettle: ReturnType<typeof readActiveSqliteTranscriptFiles>;
  try {
    sourcesToSettle = readActiveSqliteTranscriptFiles(target);
  } catch (error) {
    params.report.issues.push({
      code: "sqlite_active_transcript_scan_failed",
      message: formatErrorMessage(error),
    });
    return records;
  }
  for (const source of sourcesToSettle) {
    if (params.excludedPaths.has(canonicalMigrationFilePath(source.transcriptPath))) {
      continue;
    }
    try {
      const fingerprint = readTranscriptFingerprint(source.transcriptPath);
      readMigrationArtifactIdentity(source.transcriptPath, 1n, fingerprint);
      const primary = readLegacyPrimaryTranscriptIdentity(
        source.transcriptPath,
        source.transcriptPath,
        undefined,
        true,
      );
      if (!primary) {
        continue;
      }
      if (primary.sessionId !== source.sessionId) {
        throw new Error("Legacy transcript has no matching primary session identity");
      }
      const sources = [{ path: source.transcriptPath, sessionId: source.sessionId }];
      const verify = (mode: "contained" | "appendable" = "contained") =>
        verifyCanonicalSessionTranscriptSources({
          target,
          sources,
          env: params.env,
          mode,
        });
      let verified = verify("appendable");
      if (!verified) {
        throw new Error(
          "Missing history requires legacy format or branch repair before it can be appended",
        );
      }
      if (verified.missingEvents > 0) {
        const [imported] = await importSqliteSessionRowsBatch([
          {
            agentId: target.agentId,
            storePath: target.sqlitePath,
            env: params.env,
            sessionKey: source.sessionKey,
            entry: { sessionId: source.sessionId, updatedAt: 0 },
            historicalOnly: true,
            preserveExactStoredKey: true,
            readTranscriptEvents: createTranscriptEventReader(
              source.transcriptPath,
              source.sessionId,
              false,
              fingerprint,
            ),
          },
        ]);
        params.report.importedTranscriptEvents += imported!.transcriptEvents;
        verified = verify();
      }
      if (!verified) {
        throw new Error(
          "The original transcript order and content could not be verified in SQLite",
        );
      }
      readMigrationArtifactIdentity(source.transcriptPath, 1n, fingerprint);
      params.report.validatedEntries += 1;
      params.report.validatedTranscriptEvents += verified.events;
      records.push({
        sessionKey: source.sessionKey,
        entry: { sessionId: source.sessionId, updatedAt: 0 },
        transcriptPath: source.transcriptPath,
        transcriptDependencies: [source.transcriptPath],
        sourceFingerprint: fingerprint,
        recovery: {
          complete: true,
          repaired: false,
          events: verified.events,
          sqliteEvents: verified.sqliteEvents,
        },
      });
    } catch (error) {
      params.report.issues.push({
        code: "active_sqlite_transcript_verification_failed",
        sessionKey: source.sessionKey,
        message: `${source.transcriptPath}: ${formatErrorMessage(error)}. Original retained. Compare the named events with a verified backup, restore a corrected JSONL at this path, then rerun openclaw doctor --session-sqlite recover.`,
      });
    }
  }
  return records;
}
