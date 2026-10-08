import type { DatabaseSync } from "node:sqlite";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadResult,
} from "./openclaw-state-read.types.js";
import {
  listUserProfileAuthLinksInDatabase,
  readPersonalCatalogProfilesInDatabase,
  readUserModelAccountSummaryInDatabase,
} from "./user-model-accounts.js";

type UserModelAccountReadType =
  | "userModelAccounts.links"
  | "userModelAccounts.catalog"
  | "userModelAccounts.summary";

export function readUserModelAccountCommand(
  db: DatabaseSync,
  command: Extract<OpenClawStateReadCommand, { type: UserModelAccountReadType }>,
): Extract<OpenClawStateReadResult, { type: UserModelAccountReadType }> {
  if (command.type === "userModelAccounts.summary") {
    return {
      type: command.type,
      account: runSqliteDeferredTransactionSync(db, () =>
        readUserModelAccountSummaryInDatabase(db, command),
      ),
    };
  }
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
