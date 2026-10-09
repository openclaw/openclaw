import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { applySessionEntryPatchInDatabase } from "./session-accessor.sqlite-entry-mutation.js";
import { readSessionEntryPatchPredicate } from "./session-entry-patch-guard.js";
import { readSessionEntryPatchSnapshot } from "./session-entry-patch.worker.js";
import type {
  IncognitoEntryPatchOperations,
  IncognitoEntryPatchResult,
} from "./session-incognito-entry-patch-contract.js";
import { readRefusedSessionSource } from "./session-source-predicate.worker.js";

export function createIncognitoEntryPatchWorker(
  database: OpenClawAgentDatabase,
  incarnation: string,
  env: NodeJS.ProcessEnv,
  admit: (
    stage: "transaction" | "commit",
    keys: readonly string[],
    receipt: { guarded: boolean; value?: IncognitoEntryPatchResult },
  ) => void,
) {
  return {
    execute(command: SqliteWorkerCommand<IncognitoEntryPatchOperations>) {
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
              readSnapshot: (owner) => readSessionEntryPatchSnapshot(owner, selection),
              options: {
                consumePendingReset: input.consumePendingReset,
                providerReviewMutation: input.providerReviewMutation,
                workerGuard: { cliHistory: input.cliHistory, conversation: input.conversation },
                assertCommitAllowed() {
                  const refusedSource = readRefusedSessionSource(
                    database,
                    input.sources,
                    incarnation,
                  );
                  if (refusedSource) {
                    admit("commit", keys, {
                      guarded: false,
                      value: { entry: null, wrote: false, refusedSource },
                    });
                    throw new Error("Session source refusal was not rejected");
                  }
                  guarded = true;
                  admit("transaction", keys, { guarded });
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
          admit("commit", keys, { guarded, value: result });
          return result;
        },
        { agentId: database.agentId, path: database.path, env },
        { operationLabel: input.operationLabel },
      );
      return { value, keys };
    },
  };
}
