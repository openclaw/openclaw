import type { EngineConnection } from "../infra/sql-connection.js";
import type { OpenClawStateReadCommand } from "../state/openclaw-state-read.types.js";
import { readClawInventoryInDatabase } from "./inventory-read.kernel.js";

type ClawStateReadCommand = Extract<OpenClawStateReadCommand, { type: "claws.inventory" }>;

export function readClawStateCommandInDatabase(
  db: EngineConnection,
  command: ClawStateReadCommand,
) {
  return { type: command.type, inventory: readClawInventoryInDatabase(db) };
}
