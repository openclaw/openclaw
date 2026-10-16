import type { EngineConnection } from "../infra/sql-connection.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadResult,
} from "../state/openclaw-state-read.types.js";
import { readClawInventoryInDatabase } from "./inventory-read.kernel.js";

type ClawStateReadCommand = Extract<OpenClawStateReadCommand, { type: "claws.inventory" }>;
type ClawStateReadResult = Extract<OpenClawStateReadResult, { type: "claws.inventory" }>;

export function readClawStateCommandInDatabase(
  db: EngineConnection,
  command: ClawStateReadCommand,
): ClawStateReadResult {
  return { type: command.type, inventory: readClawInventoryInDatabase(db) };
}
