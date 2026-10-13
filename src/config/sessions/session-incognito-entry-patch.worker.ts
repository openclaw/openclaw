import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { iterateSessionEntryKeys } from "./session-accessor.sqlite-entry-inventory.js";
import { applySessionEntryPatchInDatabase } from "./session-accessor.sqlite-entry-mutation.js";
import { readSessionEntryReplacementState } from "./session-accessor.sqlite-replacement-read.js";
import { commitSessionEntryReplacementsInDatabase } from "./session-accessor.sqlite-replacement-state.js";
import { assertCanonicalSessionKeyWrite } from "./session-canonical-key.js";
import { readSessionEntryPatchPredicate } from "./session-entry-patch-guard.js";
import { readSessionEntryPatchSnapshot } from "./session-entry-patch.worker.js";
import type {
  IncognitoEntryPatchOperations,
  IncognitoEntryPatchResult,
} from "./session-incognito-entry-patch-contract.js";
import type { SessionSourceValidation } from "./session-source-authority.js";
import { readSessionSourceValidation } from "./session-source-predicate.worker.js";
import type { SessionEntry } from "./types.js";

export function createIncognitoEntryPatchWorker(
  database: OpenClawAgentDatabase,
  incarnation: string,
  env: NodeJS.ProcessEnv,
  admit: (
    stage: "transaction" | "commit",
    keys: readonly string[],
    receipt: {
      guarded: boolean;
      value?: unknown;
      sourceValidation?: SessionSourceValidation;
    },
  ) => void,
) {
  return {
    execute(command: SqliteWorkerCommand<IncognitoEntryPatchOperations>) {
      if (command.type === "session.entry.replacements.prepare") {
        const value = readSessionEntryReplacementState(database, command.input);
        const keys = [
          ...new Set([...(command.input.sessionKeys ?? []), ...value.expectedRows.keys()]),
        ];
        keys.forEach((key) => assertCanonicalSessionKeyWrite(key, database.agentId));
        return { value, keys };
      }
      if (command.type === "session.entry.replacements.commit") {
        const keys = command.input.maintenance
          ? [...new Set([...command.input.validationKeys, ...iterateSessionEntryKeys(database)])]
          : command.input.validationKeys;
        keys.forEach((key) => assertCanonicalSessionKeyWrite(key, database.agentId));
        const value = runOpenClawAgentWriteTransaction(
          () => {
            const archived = new Map<string, { previous: SessionEntry; current: SessionEntry }>();
            const result = commitSessionEntryReplacementsInDatabase(
              database,
              command.input,
              () => admit("transaction", keys, { guarded: true }),
              undefined,
              (sessionKey, previous, current) => {
                archived.set(sessionKey, { previous, current });
              },
            );
            // Actor publication includes archive facts; durable receipts invalidate those rows.
            for (const [sessionKey, entry] of archived) {
              if (!result.previous.has(sessionKey)) {
                result.previous.set(sessionKey, entry.previous);
              }
              result.current.set(sessionKey, entry.current);
            }
            admit("commit", keys, { guarded: true, value: result });
            return result;
          },
          { agentId: database.agentId, path: database.path, env },
          { operationLabel: "session.entry-replacements" },
        );
        return { value, keys };
      }
      const { sessionKey, selection } = command.input;
      if (
        (selection.kind === "entry" ? selection.sessionKey : selection.target.canonicalKey) !==
          sessionKey ||
        (selection.kind === "target" &&
          selection.target.storeKeys.some((key) => key.trim() !== sessionKey))
      ) {
        throw new Error("Incognito entry patch belongs to another session");
      }
      const keys = [sessionKey];
      if (command.type === "session.entry.patch.prepare") {
        return { value: readSessionEntryPatchSnapshot(database, selection), keys };
      }
      const input = command.input;
      const value = runOpenClawAgentWriteTransaction(
        (current): IncognitoEntryPatchResult => {
          if (current.db !== database.db) {
            throw new Error("Incognito entry patch lost its native owner");
          }
          let guarded = false;
          let sourceValidation: SessionSourceValidation | undefined;
          admit("transaction", keys, { guarded });
          let result: IncognitoEntryPatchResult = { entry: null, wrote: false };
          const predicate = readSessionEntryPatchPredicate(
            database,
            sessionKey,
            input.shouldCommitIf,
          );
          if (predicate.matches) {
            const mutation = applySessionEntryPatchInDatabase(database, {
              ...input,
              readSnapshot: (owner) => readSessionEntryPatchSnapshot(owner, selection, true),
              options: {
                consumePendingReset: input.consumePendingReset,
                providerReviewMutation: input.providerReviewMutation,
                workerGuard: { cliHistory: input.cliHistory, conversation: input.conversation },
                assertCommitAllowed() {
                  sourceValidation = readSessionSourceValidation(
                    database,
                    input.sources,
                    incarnation,
                  );
                  const { refusedSource } = sourceValidation;
                  if (refusedSource) {
                    admit("commit", keys, {
                      guarded: false,
                      value: { entry: null, wrote: false, refusedSource },
                    });
                    throw new Error("Session source refusal was not rejected");
                  }
                  guarded = true;
                  admit("transaction", keys, { guarded, sourceValidation });
                },
              },
            });
            result = {
              entry: mutation.entry,
              wrote: Boolean(mutation.identity),
              transcriptPredicate:
                mutation.entry.sessionId === predicate.transcriptPredicate?.sessionId
                  ? predicate.transcriptPredicate
                  : undefined,
            };
          }
          admit("commit", keys, { guarded, value: result, sourceValidation });
          return result;
        },
        { agentId: database.agentId, path: database.path, env },
        { operationLabel: input.operationLabel },
      );
      return { value, keys };
    },
  };
}
