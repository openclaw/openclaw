import { readAcpSessionCommand } from "../acp/runtime/session-meta-read.worker.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../infra/sqlite-transaction.js";
import type { OpenClawStateReadCommand } from "./openclaw-state-read.types.js";
import { findSessionRepositoryWorkspaceInDatabase } from "./session-repository-workspaces.kernel.js";

export function readSessionRowsSharedFacts(
  db: EngineConnection,
  command: Extract<OpenClawStateReadCommand, { type: "sessionRows.sharedFacts" }>,
) {
  const readSharedFacts = () => {
    const acp = readAcpSessionCommand(db, {
      type: "acpSessions.metadata",
      entries: command.entries.flatMap((entry) => entry.acp ?? []),
    });
    if (acp.type !== "acpSessions.metadata") {
      throw new Error("Unexpected ACP session metadata cohort");
    }
    let acpIndex = 0;
    return {
      type: command.type,
      rows: command.entries.map((entry) => {
        const workspace = entry.repositoryWorkspace
          ? findSessionRepositoryWorkspaceInDatabase(db, entry.repositoryWorkspace)
          : undefined;
        return {
          ...(entry.acp ? { acp: acp.rows[acpIndex++] ?? null } : {}),
          ...(entry.repositoryWorkspace
            ? {
                repositoryWorkspace:
                  workspace?.workspaceId === entry.repositoryWorkspace.workspaceId
                    ? workspace
                    : null,
              }
            : {}),
        };
      }),
    };
  };
  return command.entries.some((entry) => entry.repositoryWorkspace)
    ? runSqliteReadSnapshotSync(db, readSharedFacts)
    : readSharedFacts();
}
