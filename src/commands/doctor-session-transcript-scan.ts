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
import { ReadOnlySqliteTranscriptReader } from "./doctor-session-sqlite-transcript-readers.js";

/** Each snapshot closes its cursors before a repair; each pass owns only its read connection. */
export function scanDoctorSessionTranscripts(
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv; title: string; failureLabel: string },
  visit: (context: {
    reader: ReadOnlySqliteTranscriptReader;
    sessionId: string;
    target: ExistingAgentDatabaseTarget;
    databaseOptions: ReturnType<typeof resolveTargetSqliteOptions>;
    reportError: (message: string, error: unknown) => void;
  }) => void,
): void {
  const reportError = (message: string, error: unknown) =>
    note(`${message}: ${formatErrorMessage(error).replace(/\s+/g, " ").trim()}`, params.title);
  for (const target of projectExistingAgentDatabaseTargets(
    resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env }),
    params.env,
    params.cfg,
  )) {
    const databaseOptions = resolveTargetSqliteOptions(target, params.env);
    let database: DatabaseSync | undefined;
    try {
      database = openNodeSqliteDatabase(target.sqlitePath, { readOnly: true });
      const reader = new ReadOnlySqliteTranscriptReader(database);
      for (const sessionId of reader.sessionIds()) {
        visit({ reader, sessionId, target, databaseOptions, reportError });
      }
    } catch (error) {
      reportError(`- ${params.failureLabel} for ${target.agentId} (${target.sqlitePath})`, error);
    } finally {
      database?.close();
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
