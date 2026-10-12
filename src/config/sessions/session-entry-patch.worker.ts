import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import { createSqliteWorkerTransferOwner } from "../../infra/sqlite-worker-transfer.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseAdmissionRestriction } from "../../state/openclaw-agent-execution-domain.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { captureTrajectoryRuntimeRetentionMetadataMutation } from "../../trajectory/runtime-retention.sqlite.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import {
  applySessionEntryPatchInDatabase,
  writeSessionEntryPatchInDatabase,
} from "./session-accessor.sqlite-entry-mutation.js";
import {
  readLifecycleTargetSnapshot,
  readSessionEntrySelectionSnapshot,
} from "./session-accessor.sqlite-entry-store.js";
import {
  boundSessionEntryReplacementPublication,
  prepareSessionEntryReplacementPublication,
} from "./session-accessor.sqlite-replacement-state.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";
import { readSessionEntryPatchPredicate } from "./session-entry-patch-guard.js";
import { projectSessionEntryPatch } from "./session-entry-patch-operation.js";
import type {
  SessionEntryPatchCommit,
  SessionEntryPatchCommitted,
  SessionEntryPatchReceipt,
  SessionEntryPatchReduction,
  SessionEntryPatchSelection,
} from "./session-entry-patch.types.js";
import { sealSessionEntryPublicationSource } from "./session-entry-publication-source.js";
import { assertCapturedSessionEntryReadSource } from "./session-entry-read-source.js";
import { readSessionPendingInputAuthorityFactsInTransaction } from "./session-pending-input-authority.kernel.js";
import { readSessionSourceValidation } from "./session-source-predicate.worker.js";
import { readStagedSessionTranscriptAuthority } from "./session-transcript-authority.js";

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
  includeWindowFacts?: true,
) {
  return selection.kind === "target"
    ? readLifecycleTargetSnapshot(database, selection.target, { includeWindowFacts })
    : readSessionEntrySelectionSnapshot(
        database,
        selection.sessionKey,
        selection.exact,
        includeWindowFacts,
      );
}

export function commitSessionEntryPatch(
  input: SessionEntryPatchCommit | SessionEntryPatchReduction,
  { writeTransaction, admit }: AgentWorkerOperationContext,
): SessionEntryPatchReceipt {
  return writeTransaction(input.operationLabel, "Session patch", (database) => {
    if (
      input.ensureIdentitySource &&
      (!("operation" in input) || input.operation.kind !== "ensure-identity")
    ) {
      throw new Error("Transaction-local entry authority requires a closed ensure");
    }
    if (input.ensureIdentitySource) {
      assertCapturedSessionEntryReadSource(input.ensureIdentitySource.source, database);
    }
    let authority:
      | ReturnType<typeof readSessionPendingInputAuthorityFactsInTransaction>
      | undefined;
    let result: SessionEntryPatchCommitted;
    const predicate = readSessionEntryPatchPredicate(
      database,
      input.sessionKey,
      input.shouldCommitIf,
    );
    if (!predicate.matches) {
      // A false predicate precedes CAS and the throwing guard, including for a null patch.
      result = { kind: "session-entry-patch", entry: null, applied: false };
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
            result = { kind: "session-entry-patch", entry: null, applied: false, refusedSource };
            transferSessionEntryWorkerCandidate(database, admit, result);
            throw new Error("Session source refusal was not rejected");
          }
          admit("transaction", {
            kind: "session-entry-patch-validated",
            ...(authority ? { authority } : {}),
            sourceValidation: validation,
          });
        },
      };
      let mutation;
      if ("operation" in input) {
        if (input.validateCanonicalKeys) {
          assertCanonicalSqliteSessionKeysCurrent(database);
        }
        const fresh = readSessionEntryPatchSnapshot(database, input.selection, true);
        if (input.ensureIdentitySource) {
          const target =
            input.selection.kind === "target"
              ? input.selection.target
              : {
                  canonicalKey: input.selection.sessionKey,
                  storeKeys: [input.selection.sessionKey],
                };
          if (
            target.canonicalKey !== input.sessionKey ||
            ![target.canonicalKey, ...target.storeKeys].includes(
              input.ensureIdentitySource.sessionKey,
            )
          ) {
            throw new Error("Entry ensure authority belongs to another session target");
          }
          const sourceKey = fresh[0]?.sessionKey ?? input.sessionKey;
          authority = readSessionPendingInputAuthorityFactsInTransaction(
            database,
            sourceKey,
            input.ensureIdentitySource.agentId,
            new Map([[sourceKey, fresh[0]?.entry]]),
          );
        }
        const existing = fresh[0]?.entry;
        const writeBase = existing ?? input.fallbackEntry;
        if (!writeBase) {
          result = {
            kind: "session-entry-patch",
            entry: null,
            applied: false,
          };
          return transferSessionEntryWorkerCandidate(database, admit, result);
        }
        const next = projectSessionEntryPatch({
          ...input,
          existing,
          writeBase,
          operation: input.operation,
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
          readSnapshot: (current) => readSessionEntryPatchSnapshot(current, input.selection, true),
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
            { captureFullFacts: true, postimages: mutation.postimages },
          )
        : undefined;
      // Publish after every patch-owned write, including commit-receipt preparation.
      if (mutation.identity) {
        publishRetention?.();
      }
      result = {
        kind: "session-entry-patch",
        entry: mutation.entry,
        applied: mutation.applied,
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
  result: { kind: string; publication?: SessionEntryReplacementPublication },
): SessionEntryPatchReceipt;
export function transferSessionEntryWorkerCandidate<Receipt>(
  database: OpenClawAgentDatabase,
  admit: AgentWorkerOperationContext["admit"],
  result: { kind: string; publication?: SessionEntryReplacementPublication },
  wrapReceipt: (receipt: SessionEntryPatchReceipt) => Receipt,
): Receipt;
export function transferSessionEntryWorkerCandidate<Receipt>(
  database: OpenClawAgentDatabase,
  admit: AgentWorkerOperationContext["admit"],
  result: { kind: string; publication?: SessionEntryReplacementPublication },
  wrapReceipt?: (receipt: SessionEntryPatchReceipt) => Receipt,
): SessionEntryPatchReceipt | Receipt {
  // Deliver the exact candidate before COMMIT; the small native receipt certifies it afterward.
  const transfer = createSqliteWorkerTransferOwner();
  const transcriptPublication = readStagedSessionTranscriptAuthority(database);
  const candidate = transcriptPublication ? { ...result, transcriptPublication } : result;
  if (result.publication) {
    if (result.publication.source && result.publication.fullEntries?.size) {
      sealSessionEntryPublicationSource(result.publication.source);
    }
    boundSessionEntryReplacementPublication(result.publication, candidate);
  }
  const handle = transfer.start([{ kind: "patch", value: candidate }].values(), {
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
