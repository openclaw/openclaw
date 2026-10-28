import type { EngineConnection } from "../infra/sql-connection.js";
import type { OpenClawStateReadCommand } from "../state/openclaw-state-read.types.js";
import { readTemplateInventoryInDatabase } from "./inventory-read.kernel.js";

type TemplateStateReadCommand = Extract<OpenClawStateReadCommand, { type: "templates.inventory" }>;

export function readTemplateStateCommandInDatabase(
  db: EngineConnection,
  command: TemplateStateReadCommand,
) {
  return { type: command.type, inventory: readTemplateInventoryInDatabase(db) };
}
