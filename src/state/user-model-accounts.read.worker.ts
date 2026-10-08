import type { DatabaseSync } from "node:sqlite";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadResult,
} from "./openclaw-state-read.types.js";
import {
  listUserProfileAuthLinksInDatabase,
  readPersonalCatalogProfilesInDatabase,
} from "./user-model-accounts.js";

type UserModelAccountReadType = "userModelAccounts.links" | "userModelAccounts.catalog";

export function readUserModelAccountCommand(
  db: DatabaseSync,
  command: Extract<OpenClawStateReadCommand, { type: UserModelAccountReadType }>,
): Extract<OpenClawStateReadResult, { type: UserModelAccountReadType }> {
  if (command.type === "userModelAccounts.links") {
    return {
      type: command.type,
      links: runSqliteDeferredTransactionSync(db, () =>
        listUserProfileAuthLinksInDatabase(db, command.profileId),
      ),
    };
  }
  return {
    type: command.type,
    catalog: readPersonalCatalogProfilesInDatabase(db, command.selection),
  };
}
