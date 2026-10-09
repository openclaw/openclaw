import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import { createSqliteWorkerTransferOwner } from "../../infra/sqlite-worker-transfer.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseAdmissionRestriction } from "../../state/openclaw-agent-execution-domain.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { captureTrajectoryRuntimeRetentionMetadataMutation } from "../../trajectory/runtime-retention.sqlite.js";
import {
  applySessionEntryPatchInDatabase,
  writeSessionEntryPatchInDatabase,
} from "./session-accessor.sqlite-entry-mutation.js";
import {
  readLifecycleTargetSnapshot,
  readSessionEntrySelectionSnapshot,
} from "./session-accessor.sqlite-entry-store.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";
import { readSessionEntryPatchPredicate } from "./session-entry-patch-guard.js";
import {
  mergeSessionEntryPatch,
  reduceSessionEntryPatch,
} from "./session-entry-patch-operation.js";
import type {
  SessionEntryPatchCommit,
  SessionEntryPatchCommitted,
  SessionEntryPatchReceipt,
  SessionEntryPatchReduction,
  SessionEntryPatchSelection,
} from "./session-entry-patch.types.js";
import { readSessionSourceValidation } from "./session-source-predicate.worker.js";

/** Connection-bound domains share the executor's transaction and publication grants. */
export function createSessionWorkerOperationContext(
  database: OpenClawAgentDatabase,
  options: AgentWorkerOperationContext["options"],
  bound: {
    admit(stage: "transaction" | "commit", restriction?: AgentDatabaseAdmissionRestriction): void;
  },
  domain: string,
): AgentWorkerOperationContext {
  const native = database.db;
  const context: AgentWorkerOperationContext = {
    options,
    open: () => database,
    admit(stage, publication) {
      bound.admit(stage, (request, dispatch) => {
        if (!isRecord(request.facts)) {
          throw new Error(`${domain} admission omitted its database identity`);
        }
        dispatch({ ...request, facts: { ...request.facts, publication } });
      });
    },
    writeTransaction(operationLabel, owner, write) {
      return runOpenClawAgentWriteTransaction(
        (current) => {
          if (current.db !== native) {
            throw new Error(`${owner} lost its canonical database owner`);
          }
          context.admit("transaction");
          return write(current);
        },
        options,
        { operationLabel },
      );
    },
  };
  return context;
}

export function readSessionEntryPatchSnapshot(
  database: OpenClawAgentDatabase,
  selection: SessionEntryPatchSelection,
) {
  return selection.kind === "target"
    ? readLifecycleTargetSnapshot(database, selection.target)
    : readSessionEntrySelectionSnapshot(database, selection.sessionKey, selection.exact);
}

export function commitSessionEntryPatch(
  input: SessionEntryPatchCommit | SessionEntryPatchReduction,
  { writeTransaction, admit }: AgentWorkerOperationContext,
): SessionEntryPatchReceipt {
  return writeTransaction(input.operationLabel, "Session patch", (database) => {
    let result: SessionEntryPatchCommitted;
    const predicate = readSessionEntryPatchPredicate(
      database,
      input.sessionKey,
      input.shouldCommitIf,
    );
    if (!predicate.matches) {
      // A false predicate precedes CAS and the throwing guard, including for a null patch.
      result = { kind: "session-entry-patch", entry: null };
    } else {
      const publishRetention =
        "operation" in input || input.next
          ? captureTrajectoryRuntimeRetentionMetadataMutation(database.db)
          : undefined;
      const options = {
        consumePendingReset: input.consumePendingReset,
        providerReviewMutation: input.providerReviewMutation,
        workerGuard: { cliHistory: input.cliHistory, conversation: input.conversation },
        assertCommitAllowed: () => {
          const validation = readSessionSourceValidation(database, input.sources);
          const { refusedSource } = validation;
          if (refusedSource) {
            result = { kind: "session-entry-patch", entry: null, refusedSource };
            transferSessionEntryWorkerCandidate(database, admit, result);
            throw new Error("Session source refusal was not rejected");
          }
          admit("transaction", {
            kind: "session-entry-patch-validated",
            sourceValidation: validation,
          });
        },
      };
      let mutation;
      if ("operation" in input) {
        if (input.validateCanonicalKeys) {
          assertCanonicalSqliteSessionKeysCurrent(database);
        }
        const fresh = readSessionEntryPatchSnapshot(database, input.selection);
        const existing = fresh[0]?.entry;
        const writeBase = existing ?? input.fallbackEntry;
        if (!writeBase) {
          result = {
            kind: "session-entry-patch",
            entry: null,
          };
          return transferSessionEntryWorkerCandidate(database, admit, result);
        }
        const next = mergeSessionEntryPatch({
          ...input,
          existing,
          writeBase,
          patch: reduceSessionEntryPatch(input.operation, writeBase),
        });
        mutation = writeSessionEntryPatchInDatabase(database, {
          sessionKey: input.sessionKey,
          fresh,
          writeBase,
          next,
          options,
        });
      } else {
        mutation = applySessionEntryPatchInDatabase(database, {
          ...input,
          readSnapshot: (current) => readSessionEntryPatchSnapshot(current, input.selection),
          options,
        });
      }
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
      // Publish after every patch-owned write, including commit-receipt preparation.
      if (mutation.identity) {
        publishRetention?.();
      }
      result = {
        kind: "session-entry-patch",
        entry: mutation.entry,
        publication,
        transcriptPredicate:
          mutation.entry.sessionId === predicate.transcriptPredicate?.sessionId
            ? predicate.transcriptPredicate
            : undefined,
      };
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
