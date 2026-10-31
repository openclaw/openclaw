import type { DatabaseSync } from "node:sqlite";
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  projectExistingAgentDatabaseTargets,
  resolveTargetSqliteOptions,
  type ExistingAgentDatabaseTarget,
} from "../infra/session-sqlite-migration-readers.js";
import { beginUpdateDoctorHistoricalScan } from "../infra/update-doctor-scan-receipts.js";
import { ReadOnlySqliteTranscriptReader } from "./doctor-session-sqlite-transcript-readers.js";

/** Each snapshot closes its cursors before a repair; each pass owns only its read connection. */
export function scanDoctorSessionTranscripts(
  params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    title: string;
    failureLabel: string;
    cleanScanIdentity?: (target: ExistingAgentDatabaseTarget) => readonly unknown[];
    selectSessionIds?: (
      reader: ReadOnlySqliteTranscriptReader,
      reportError: (sessionId: string, error: unknown) => void,
    ) => readonly string[];
  },
  visit: (context: {
    reader: ReadOnlySqliteTranscriptReader;
    sessionId: string;
    target: ExistingAgentDatabaseTarget;
    databaseOptions: ReturnType<typeof resolveTargetSqliteOptions>;
    reportError: (message: string, error: unknown) => void;
  }) => boolean | void,
): void {
  const reportError = (message: string, error: unknown) =>
    note(`${message}: ${formatErrorMessage(error).replace(/\s+/g, " ").trim()}`, params.title);
  for (const candidate of projectExistingAgentDatabaseTargets(
    resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env }),
    params.env,
    params.cfg,
  )) {
    const scan = params.cleanScanIdentity
      ? beginUpdateDoctorHistoricalScan(candidate.sqlitePath, params.cleanScanIdentity(candidate))
      : undefined;
    if (scan?.reused) {
      scan.complete();
      continue;
    }
    // The read connection and any repair must use the admitted owner, not a mutable alias.
    const target = scan ? { ...candidate, sqlitePath: scan.databasePath } : candidate;
    let clean = true;
    const reportTargetError = (message: string, error: unknown) => {
      clean = false;
      reportError(message, error);
    };
    const databaseOptions = resolveTargetSqliteOptions(target, params.env);
    let database: DatabaseSync | undefined;
    try {
      database = openNodeSqliteDatabase(target.sqlitePath, { readOnly: true });
      const reader = new ReadOnlySqliteTranscriptReader(database);
      const sessionIds = params.selectSessionIds
        ? params.selectSessionIds(reader, (sessionId, error) =>
            reportTargetError(
              `- Failed to read transcript ${sessionId} (${target.agentId})`,
              error,
            ),
          )
        : reader.sessionIds();
      for (const sessionId of sessionIds) {
        if (
          visit({ reader, sessionId, target, databaseOptions, reportError: reportTargetError }) ===
          false
        ) {
          clean = false;
        }
      }
    } catch (error) {
      reportTargetError(
        `- ${params.failureLabel} for ${target.agentId} (${target.sqlitePath})`,
        error,
      );
    } finally {
      database?.close();
    }
    if (clean) {
      scan?.complete();
    }
  }
}

export function transcriptSnapshotsMatch<
  Row extends { seq: number; eventJson: string; createdAt?: number },
>(expected: readonly Row[], current: readonly Row[], compareCreatedAt = false): boolean {
  return (
    expected.length === current.length &&
    expected.every(
      (row, index) =>
        row.seq === current[index]?.seq &&
        (!compareCreatedAt || row.createdAt === current[index]?.createdAt) &&
        row.eventJson === current[index]?.eventJson,
    )
  );
}
