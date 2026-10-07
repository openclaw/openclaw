import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import { createSqliteWorkerTransferOwner } from "../../infra/sqlite-worker-transfer.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { applySessionEntryPatchInDatabase } from "./session-accessor.sqlite-entry-mutation.js";
import {
  readLifecycleTargetSnapshot,
  readSessionEntrySelectionSnapshot,
} from "./session-accessor.sqlite-entry-store.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import { sessionEntryPatchPredicateMatches } from "./session-entry-patch-guard.js";
import type {
  SessionEntryPatchCommit,
  SessionEntryPatchCommitted,
  SessionEntryPatchReceipt,
  SessionEntryPatchSelection,
} from "./session-entry-patch.types.js";
import { readRefusedSessionSource } from "./session-source-predicate.worker.js";

export function readSessionEntryPatchSnapshot(
  database: OpenClawAgentDatabase,
  selection: SessionEntryPatchSelection,
) {
  return selection.kind === "target"
    ? readLifecycleTargetSnapshot(database, selection.target)
    : readSessionEntrySelectionSnapshot(database, selection.sessionKey, selection.exact);
}

export function commitSessionEntryPatch(
  input: SessionEntryPatchCommit,
  { writeTransaction, admit }: AgentWorkerOperationContext,
): SessionEntryPatchReceipt {
  return writeTransaction(input.operationLabel, "Session patch", (database) => {
    let result: SessionEntryPatchCommitted;
    if (!sessionEntryPatchPredicateMatches(database, input.sessionKey, input.shouldCommitIf)) {
      // A false predicate precedes CAS and the throwing guard, including for a null patch.
      result = { kind: "session-entry-patch", entry: null };
    } else {
      const mutation = applySessionEntryPatchInDatabase(database, {
        ...input,
        readSnapshot: (current) => readSessionEntryPatchSnapshot(current, input.selection),
        options: {
          consumePendingReset: input.consumePendingReset,
          providerReviewMutation: input.providerReviewMutation,
          workerGuard: { cliHistory: input.cliHistory },
          assertCommitAllowed: () => {
            const refusedSource = readRefusedSessionSource(database, input.sources);
            if (refusedSource) {
              result = { kind: "session-entry-patch", entry: null, refusedSource };
              transferSessionEntryWorkerCandidate(database, admit, result);
              throw new Error("Session source refusal was not rejected");
            }
            admit("transaction", { kind: "session-entry-patch-validated" });
          },
        },
      });
      const publication = mutation.identity
        ? prepareSessionEntryReplacementPublication(
            {
              ...mutation.identity,
              pendingArchiveRecovery: false,
              membershipInvalidatedKeys: [],
              maintenancePlans: [],
            },
            database,
          )
        : undefined;
      result = { kind: "session-entry-patch", entry: mutation.entry, publication };
    }
    return transferSessionEntryWorkerCandidate(database, admit, result);
  });
}

export function transferSessionEntryWorkerCandidate(
  database: OpenClawAgentDatabase,
  admit: AgentWorkerOperationContext["admit"],
  result: { kind: string },
): SessionEntryPatchReceipt;
export function transferSessionEntryWorkerCandidate<Receipt>(
  database: OpenClawAgentDatabase,
  admit: AgentWorkerOperationContext["admit"],
  result: { kind: string },
  wrapReceipt: (receipt: SessionEntryPatchReceipt) => Receipt,
): Receipt;
export function transferSessionEntryWorkerCandidate<Receipt>(
  database: OpenClawAgentDatabase,
  admit: AgentWorkerOperationContext["admit"],
  result: { kind: string },
  wrapReceipt?: (receipt: SessionEntryPatchReceipt) => Receipt,
): SessionEntryPatchReceipt | Receipt {
  // Deliver the exact candidate before COMMIT; the small native receipt certifies it afterward.
  const transfer = createSqliteWorkerTransferOwner();
  const handle = transfer.start([{ kind: "patch", value: result }].values(), {
    kinds: ["patch"],
  });
  try {
    admit("transaction", { kind: "session-entry-patch-transfer", handle });
    for (;;) {
      const frame = transfer.next(handle.id);
      admit("transaction", { kind: "session-entry-patch-frame", frame });
      if (frame.done) {
        break;
      }
    }
    const receipt: SessionEntryPatchReceipt = {
      kind: "session-entry-patch-committed",
      transferId: handle.id,
    };
    const publication = wrapReceipt ? wrapReceipt(receipt) : receipt;
    deferSqliteWorkerCommitReceipt(database.db, publication);
    admit("commit", publication);
    return publication;
  } finally {
    transfer.cancel();
  }
}
