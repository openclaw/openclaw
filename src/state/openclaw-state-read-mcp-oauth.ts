import type { DatabaseSync } from "node:sqlite";
import {
  countMcpOAuthPrincipalsInDatabase,
  listMcpOAuthStoreKeysInDatabase,
  readMcpOAuthPendingInDatabase,
  readMcpOAuthStoreIfPresentInDatabase,
  readMcpOAuthStatusesInDatabase,
} from "../agents/mcp-oauth-store.kernel.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadResult,
} from "./openclaw-state-read.types.js";

export function readMcpOAuthStateCommand(
  db: DatabaseSync,
  command: Extract<OpenClawStateReadCommand, { type: `mcpOAuth.${string}` }>,
): OpenClawStateReadResult {
  if (command.type === "mcpOAuth.statuses") {
    return { type: command.type, value: readMcpOAuthStatusesInDatabase(db, command.input) };
  }
  if (command.type === "mcpOAuth.readOnly") {
    return { type: command.type, value: readMcpOAuthStoreIfPresentInDatabase(db, command.input) };
  }
  if (command.type === "mcpOAuth.keys") {
    return { type: command.type, value: listMcpOAuthStoreKeysInDatabase(db, command.input) };
  }
  if (command.type === "mcpOAuth.pending") {
    return { type: command.type, value: readMcpOAuthPendingInDatabase(db, command.input) };
  }
  return { type: command.type, value: countMcpOAuthPrincipalsInDatabase(db, command.input) };
}
