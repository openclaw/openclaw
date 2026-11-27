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
import { resolveSqliteInspectionSignal } from "../infra/sqlite-readonly-worker-context.js";
import { beginUpdateDoctorHistoricalScan } from "../infra/update-doctor-scan-receipts.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { decideDoctorPendingFromLiveStores } from "./doctor-live-store-pending.js";
import type { DoctorMaintenancePending } from "./doctor-maintenance-pending.js";
import { ReadOnlySqliteTranscriptReader } from "./doctor-session-sqlite-transcript-readers.js";

type DoctorSessionTranscriptScanParams = {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  cleanScanIdentity?: (target: ExistingAgentDatabaseTarget) => readonly unknown[];
  selectSessionIds?: (
    reader: ReadOnlySqliteTranscriptReader,
    reportError: (sessionId: string, error: unknown) => void,
  ) => readonly string[];
};

function listDoctorSessionTranscriptTargets(params: DoctorSessionTranscriptScanParams) {
  return projectExistingAgentDatabaseTargets(
    resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env }),
    params.env,
    params.cfg,
  );
}

/** Each snapshot closes its cursors before a repair; each pass owns only its read connection. */
export async function scanDoctorSessionTranscripts(
  params: DoctorSessionTranscriptScanParams & { title: string; failureLabel: string },
  visit: (context: {
    reader: ReadOnlySqliteTranscriptReader;
    sessionId: string;
    target: ExistingAgentDatabaseTarget;
    databaseOptions: ReturnType<typeof resolveTargetSqliteOptions>;
    reportError: (message: string, error: unknown) => void;
  }) => boolean | void | Promise<boolean | void>,
): Promise<void> {
  const signal = resolveSqliteInspectionSignal();
  signal?.throwIfAborted();
  const reportError = (message: string, error: unknown) =>
    note(`${message}: ${formatErrorMessage(error).replace(/\s+/g, " ").trim()}`, params.title);
  for (const candidate of listDoctorSessionTranscriptTargets(params)) {
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
        signal?.throwIfAborted();
        if (
          (await visit({
            reader,
            sessionId,
            target,
            databaseOptions,
            reportError: reportTargetError,
          })) === false
        ) {
          clean = false;
        }
        signal?.throwIfAborted();
      }
    } catch (error) {
      signal?.throwIfAborted();
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

/**
 * Read-only: whether a repair built on {@link scanDoctorSessionTranscripts} with the same
 * parameters would rewrite a session. `plan` answers per session from the same snapshot
 * the repair reads; a failed read is undecidable. Targets an update has already scanned
 * clean are skipped, as the repair skips them. The agent stores are read live (see
 * {@link decideDoctorPendingFromLiveStores}).
 */
export async function checkDoctorSessionTranscriptsPending(
  params: DoctorSessionTranscriptScanParams,
  plan: (context: {
    reader: ReadOnlySqliteTranscriptReader;
    sessionId: string;
    target: ExistingAgentDatabaseTarget;
  }) => DoctorMaintenancePending,
): Promise<DoctorMaintenancePending> {
  // Resolving the targets reads the agent registry in the state database.
  return decideDoctorPendingFromLiveStores([resolveOpenClawStateSqlitePath(params.env)], () => {
    const targets = listDoctorSessionTranscriptTargets(params).flatMap((candidate) => {
      const scan = params.cleanScanIdentity
        ? beginUpdateDoctorHistoricalScan(candidate.sqlitePath, params.cleanScanIdentity(candidate))
        : undefined;
      return scan?.reused
        ? []
        : [scan ? { ...candidate, sqlitePath: scan.databasePath } : candidate];
    });
    return decideDoctorPendingFromLiveStores(
      targets.map((target) => target.sqlitePath),
      () => {
        let undecidable = false;
        for (const target of targets) {
          let database: DatabaseSync | undefined;
          try {
            database = openNodeSqliteDatabase(target.sqlitePath, { readOnly: true });
            const reader = new ReadOnlySqliteTranscriptReader(database);
            const sessionIds = params.selectSessionIds
              ? params.selectSessionIds(reader, () => {
                  undecidable = true;
                })
              : reader.sessionIds();
            for (const sessionId of sessionIds) {
              const pending = plan({ reader, sessionId, target });
              if (pending === "work") {
                return "work";
              }
              undecidable ||= pending === "undecidable";
            }
          } catch {
            undecidable = true;
          } finally {
            database?.close();
          }
        }
        return undecidable ? "undecidable" : "none";
      },
    );
  });
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
