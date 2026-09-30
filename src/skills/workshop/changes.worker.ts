import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  listWorkshopChangesInDatabase,
  recordWorkshopChangeInDatabase,
  type WorkshopChange,
} from "./changes.kernel.js";
import type { WorkshopChangesWorkerOperations } from "./changes.worker-contract.js";

export function isWorkshopChangesCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<WorkshopChangesWorkerOperations> {
  return (
    command.type === "skills.workshop.changes.record" ||
    command.type === "skills.workshop.changes.list"
  );
}

export function executeWorkshopChangesCommand(
  command: SqliteWorkerCommand<WorkshopChangesWorkerOperations>,
  database: OpenClawStateDatabase,
  databasePath: string,
): WorkshopChange[] | void {
  if (command.type === "skills.workshop.changes.list") {
    return listWorkshopChangesInDatabase(database.db, command.input);
  }
  const change = command.input;
  runOpenClawStateWriteTransaction(
    (current) => recordWorkshopChangeInDatabase(current, change),
    { database, path: databasePath, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "skill-workshop.changes.record" },
  );
}
