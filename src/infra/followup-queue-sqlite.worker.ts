import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { ensureFollowupQueueEntriesSchemaInDatabase } from "../state/openclaw-state-db-schema-additive.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { FollowupQueueWorkerOperations } from "./followup-queue-sqlite.contract.js";
import {
  followupQueueEntryContainsPromptInDatabase,
  hasFollowupQueueEntriesInDatabase,
  listFollowupQueueKeysInDatabase,
  listUnreadableFollowupQueueKeysInDatabase,
  loadFollowupQueueEntriesInDatabase,
  loadFollowupQueueEntryInDatabase,
  replaceFollowupQueueEntriesInDatabase,
} from "./followup-queue-sqlite.kernel.js";
/**
 * Shared-state worker handler for durable follow-up queue storage.
 *
 * Runtime enqueue and settlement dispatch here instead of opening a transaction
 * on the Gateway thread. The worker owns the write transaction, so snapshot
 * replacement and its retention scan no longer block the event loop while the
 * database is contended.
 */
import type { SqliteWorkerCommand } from "./sqlite-worker-contract.js";

/** Select this feature's commands from the typed shared-state wire contract. */
export function isFollowupQueueWorkerCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<FollowupQueueWorkerOperations> {
  switch (command.type) {
    case "followupQueue.listKeys":
    case "followupQueue.listUnreadableKeys":
    case "followupQueue.loadEntry":
    case "followupQueue.loadEntries":
    case "followupQueue.hasEntries":
    case "followupQueue.replace":
    case "followupQueue.entryContainsPrompt":
      return true;
    default:
      return false;
  }
}

export function executeFollowupQueueWorkerCommand(
  database: OpenClawStateDatabase,
  command: SqliteWorkerCommand<FollowupQueueWorkerOperations>,
): FollowupQueueWorkerOperations[keyof FollowupQueueWorkerOperations]["output"] {
  // The table is lazy-additive, so ensure it before the first read as well: a
  // restore that runs before any write would otherwise fail on a missing table.
  ensureFollowupQueueEntriesSchemaInDatabase(database.db);
  switch (command.type) {
    case "followupQueue.listKeys":
      return listFollowupQueueKeysInDatabase(database.db);
    case "followupQueue.listUnreadableKeys":
      return listUnreadableFollowupQueueKeysInDatabase(database.db);
    case "followupQueue.loadEntry":
      return loadFollowupQueueEntryInDatabase(database.db, command.input);
    case "followupQueue.loadEntries":
      return loadFollowupQueueEntriesInDatabase(database.db).map(([queueKey, data]) => ({
        queueKey,
        data,
      }));
    case "followupQueue.hasEntries":
      return hasFollowupQueueEntriesInDatabase(database.db);
    case "followupQueue.replace": {
      const { entries, retainKeys } = command.input;
      const now = Date.now();
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          replaceFollowupQueueEntriesInDatabase(db, { entries, retainKeys, now });
        },
        { database },
        { operationLabel: "followupQueue.replace" },
      );
      return undefined;
    }
    case "followupQueue.entryContainsPrompt":
      return followupQueueEntryContainsPromptInDatabase(
        database.db,
        command.input.queueKey,
        command.input.prompt,
      );
    default:
      return undefined;
  }
}
