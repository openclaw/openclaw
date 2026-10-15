import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  workspaceFileToRow,
  type PersistedClawWorkspaceFile,
  type WorkspaceDatabase,
} from "./workspace-state.js";

export function persistClawWorkspaceFile(
  record: PersistedClawWorkspaceFile,
  options: OpenClawStateDatabaseOptions,
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<WorkspaceDatabase>(db)
        .insertInto("claw_workspace_files")
        .values(workspaceFileToRow(record)),
    );
  }, options);
}

export function updateClawWorkspaceFileStatus(
  record: PersistedClawWorkspaceFile,
  expectedStatuses: PersistedClawWorkspaceFile["status"][],
  options: OpenClawStateDatabaseOptions,
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const result = executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<WorkspaceDatabase>(db)
        .updateTable("claw_workspace_files")
        .set({ status: record.status, updated_at_ms: record.updatedAtMs })
        .where("agent_id", "=", record.agentId)
        .where("target_path", "=", record.path)
        .where("status", "in", expectedStatuses),
    );
    if (result.numAffectedRows !== 1n) {
      throw new Error(
        `Claw workspace file ${JSON.stringify(record.path)} changed ownership state concurrently.`,
      );
    }
  }, options);
}
