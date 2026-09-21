import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { OpenClawStateWorkerOperations } from "../../state/openclaw-state-worker-contract.js";
import { readSkillCuratorStateInDatabase, recordSkillUsageInDatabase } from "./curator.kernel.js";
import { listStoredSkillProposalEventsInDatabase } from "./store-sqlite-event.js";
import { ensureSkillWorkshopSchemaInDatabase } from "./store-sqlite-schema.js";

type Operations = Pick<
  OpenClawStateWorkerOperations,
  "skills.curator.read" | "skills.usage.record" | "workshop.events.list"
>;

export function isSkillWorkshopCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<Operations> {
  return (
    command.type === "skills.curator.read" ||
    command.type === "skills.usage.record" ||
    command.type === "workshop.events.list"
  );
}

export function executeSkillWorkshopCommand(
  command: SqliteWorkerCommand<Operations>,
  database: OpenClawStateDatabase,
  databasePath: string,
): Operations[keyof Operations]["output"] {
  if (command.type === "skills.curator.read") {
    return readSkillCuratorStateInDatabase(database, command.input.skillFiles);
  }
  const options = {
    database,
    path: databasePath,
    env: getSqliteWorkerStateContext().environment,
  };
  if (command.type === "skills.usage.record") {
    return runOpenClawStateWriteTransaction(
      (current) => recordSkillUsageInDatabase(current, command.input),
      options,
    );
  }
  ensureSkillWorkshopSchemaInDatabase(database, options);
  return listStoredSkillProposalEventsInDatabase(database.db, command.input);
}
