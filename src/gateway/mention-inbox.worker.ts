import type { DatabaseSync } from "node:sqlite";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import {
  readMentionStoreHead,
  readMentionStoreSnapshot,
  writeMentionStoreChanges,
} from "./mention-inbox-store.js";
import type { MentionMutation, MentionMutationResult } from "./mention-inbox.worker-contract.js";

export const mentionReadOperations = {
  "mentions.snapshot": (revision: number, db) => ({
    type: "mentions.snapshot" as const,
    snapshot: runSqliteDeferredTransactionSync(db, () => readMentionStoreSnapshot(revision, db), {
      operationLabel: "mentions.read",
    }),
  }),
} satisfies WorkerOperationHandlers<DatabaseSync>;

export const mentionWorkerOperations = {
  "mentions.mutate": (input: MentionMutation, { open, stateOptions }): MentionMutationResult =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const head = readMentionStoreHead(db);
        let result: MentionMutationResult;
        if (
          head.revision !== input.expectedHead.revision ||
          head.nextSequence !== input.expectedHead.nextSequence
        ) {
          const snapshot = readMentionStoreSnapshot(-1, db);
          if (!snapshot) {
            throw new Error("Mention snapshot is unavailable inside its transaction");
          }
          result = { kind: "conflict", snapshot };
        } else {
          result = {
            kind: "committed",
            head: writeMentionStoreChanges(
              db,
              { ...head, nextSequence: input.nextSequence },
              new Map(input.changes),
            ),
          };
        }
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        if (result.kind === "committed") {
          deferSqliteWorkerCommitReceipt(db, result);
        }
        return result;
      },
      { database: open(), ...stateOptions() },
      { operationLabel: "mentions.mutate" },
    ),
} satisfies WorkerOperationHandlers;
