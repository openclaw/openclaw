import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import {
  assertSessionCreationLabelAvailable,
  readSessionCreationSnapshotInDatabase,
} from "./session-accessor.sqlite-creation-read.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionOwnerInTransaction } from "./session-accessor.sqlite-owner.js";
import { ensureTranscriptHeader } from "./session-accessor.sqlite-transcript-header.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type { IncognitoEntryCreationOperations } from "./session-incognito-entry-creation-contract.js";
import { SqliteSessionMutationConflictError } from "./session-mutation-conflict-error.js";
import type { SessionEntry } from "./types.js";

export function createIncognitoEntryCreationWorker(
  database: OpenClawAgentDatabase,
  env: NodeJS.ProcessEnv,
  admit: (
    stage: "transaction" | "commit",
    keys: readonly string[],
    entry: { value?: SessionEntry },
  ) => void,
) {
  return {
    execute(command: SqliteWorkerCommand<IncognitoEntryCreationOperations>) {
      const { sessionKey } = command.input;
      const keys = [sessionKey];
      if (command.type === "session.entry.creation.prepare") {
        return {
          value: readSessionCreationSnapshotInDatabase(database, sessionKey, command.input.label),
          keys,
        };
      }
      const input = command.input;
      const value = runOpenClawAgentWriteTransaction(
        (current) => {
          if (current.db !== database.db) {
            throw new Error("Incognito creation lost its native owner");
          }
          const before = readSessionCreationSnapshotInDatabase(database, sessionKey, input.label);
          if (
            before.legacyKeys.length ||
            input.prepared.legacyKeys.length ||
            !sqliteSessionEntriesEqual(before.targetEntry, input.prepared.targetEntry) ||
            !sqliteSessionEntriesEqual(before.existingEntry, input.prepared.existingEntry)
          ) {
            throw new SqliteSessionMutationConflictError("session.entry.create-with-transcript");
          }
          admit("transaction", keys, {});
          assertSessionCreationLabelAvailable(database, sessionKey, input.label);
          const scope = {
            agentId: database.agentId,
            path: database.path,
            sessionKey,
            sessionId: input.entry.sessionId,
          };
          if (!input.transcriptEvents) {
            // The entry captures header provenance and its observed mutation timestamp.
            ensureTranscriptHeader(database, scope, input.cwd);
          }
          const entry = writeSessionEntry(
            database,
            sessionKey,
            { ...input.entry, incognito: true },
            { previousEntry: before.targetEntry ?? null },
          );
          if (input.transcriptEvents) {
            appendTranscriptEventsInTransaction(database, scope, input.transcriptEvents);
          }
          if (input.owner && !replaceSessionOwnerInTransaction(database, sessionKey, input.owner)) {
            throw new Error(`Session owner assignment lost its target: ${sessionKey}`);
          }
          admit("commit", keys, { value: entry });
          return entry;
        },
        { agentId: database.agentId, path: database.path, env },
        { operationLabel: "session.entry.create-with-transcript" },
      );
      return { value, keys };
    },
  };
}
