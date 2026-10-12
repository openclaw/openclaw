import type { DatabaseSync } from "node:sqlite";
import { readAcpSessionCommand } from "../acp/runtime/session-meta-read.worker.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadResult,
} from "./openclaw-state-read.types.js";
import { findSessionRepositoryWorkspaceInDatabase } from "./session-repository-workspaces.kernel.js";

export function readSessionRowsSharedFacts(
  db: DatabaseSync,
  command: Extract<OpenClawStateReadCommand, { type: "sessionRows.sharedFacts" }>,
): Extract<OpenClawStateReadResult, { type: "sessionRows.sharedFacts" }> {
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
    ? runSqliteDeferredTransactionSync(db, readSharedFacts)
    : readSharedFacts();
}
