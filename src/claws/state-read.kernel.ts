import type { DatabaseSync } from "node:sqlite";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadResult,
} from "../state/openclaw-state-read.types.js";
import { readClawInventoryInDatabase } from "./inventory-read.kernel.js";
import { readClawRemoveFactsInDatabase } from "./remove-facts.kernel.js";

type ClawStateReadCommand = Extract<
  OpenClawStateReadCommand,
  { type: "claws.inventory" | "claws.removeFacts" }
>;
type ClawStateReadResult = Extract<
  OpenClawStateReadResult,
  { type: "claws.inventory" | "claws.removeFacts" }
>;

export function readClawStateCommandInDatabase(
  db: DatabaseSync,
  command: ClawStateReadCommand,
): ClawStateReadResult {
  if (command.type === "claws.inventory") {
    return { type: command.type, inventory: readClawInventoryInDatabase(db) };
  }
  return {
    type: command.type,
    facts: readClawRemoveFactsInDatabase(db, command.agentId, command.sessionStorePaths),
  };
}
