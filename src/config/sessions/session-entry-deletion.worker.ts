import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import {
  prepareSessionDeletionInDatabase,
  readValidatedSessionDeletionTarget,
} from "./session-accessor.sqlite-deletion-plan.js";
import {
  cacheValidityTokensEqual,
  readSessionEntryCacheValidityToken,
} from "./session-accessor.sqlite-entry-revision.js";
import type { SessionDeletionPlanningOperation } from "./session-accessor.sqlite-lifecycle-types.js";
import { collectReclamationEntryReplacement } from "./session-accessor.sqlite-reclamation-publication.js";
import { reclaimSqliteSessionInTransaction } from "./session-accessor.sqlite-reclamation.js";
import {
  readSessionGenerationIdsForKeys,
  readSessionReferenceOwners,
} from "./session-accessor.sqlite-references.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-publication.js";
import type {
  SessionEntryDeletionCommitted,
  SessionEntryDeletionInput,
} from "./session-entry-deletion.types.js";
import type { SessionEntryPatchReceipt } from "./session-entry-patch.types.js";
import { transferSessionEntryWorkerCandidate } from "./session-entry-patch.worker.js";
import { runSessionNativeBindingTransaction } from "./session-native-binding.worker.js";

export function planSessionDeletionInAgentWorker(
  planning: SessionDeletionPlanningOperation,
  { open }: AgentWorkerOperationContext,
) {
  const database = open();
  return runSqliteReadSnapshotSync(database.db, () =>
    prepareSessionDeletionInDatabase(database, planning),
  );
}

export function deleteSessionEntryInAgentWorker(
  input: SessionEntryDeletionInput,
  context: AgentWorkerOperationContext,
) {
  const plan = {
    ...input.plan,
    databaseOptions: { ...input.plan.databaseOptions, ...context.options },
  };
  const preparedOwners = new Map<string, Map<string, string>>();
  const source = context.open();
  const revision = readSessionEntryCacheValidityToken(source.db);
  // Empty-transcript deletion only rehomes retained windows. Prepare its survivor
  // scan before BEGIN; any intervening write makes the commit use current rows.
  if (
    plan.materializedPlans.length === 0 &&
    revision.siblingWriteRevision !== undefined &&
    readValidatedSessionDeletionTarget(source, {
      ...plan,
      scope: { kind: "entry", phase: "commit" },
    })
  ) {
    for (const key of new Set([
      plan.deleteParams.target.canonicalKey,
      ...plan.deleteParams.target.storeKeys,
    ])) {
      const sessionKey = key.trim();
      preparedOwners.set(
        sessionKey,
        readSessionReferenceOwners(
          source,
          new Set([sessionKey]),
          readSessionGenerationIdsForKeys(source, [sessionKey]),
        ),
      );
    }
  }
  const mutate = <Receipt extends object>(
    database: OpenClawAgentDatabase,
    wrapReceipt: (receipt: SessionEntryPatchReceipt) => Receipt,
  ): Receipt => {
    const result = reclaimSqliteSessionInTransaction(plan, {
      preparedReferenceOwners: (sessionKey) =>
        database.db === source.db &&
        cacheValidityTokensEqual(revision, readSessionEntryCacheValidityToken(database.db))
          ? preparedOwners.get(sessionKey)
          : undefined,
    });
    if (result.kind !== "entry") {
      throw new Error("Session entry deletion returned another reclamation operation");
    }
    const replacement = collectReclamationEntryReplacement(plan, result);
    const publication = replacement
      ? prepareSessionEntryReplacementPublication(replacement, database)
      : undefined;
    if (publication && result.value.transcriptInventoryUnchanged) {
      publication.transcriptInventoryUnchanged = true;
    }
    const candidate: SessionEntryDeletionCommitted = {
      kind: "session-entry-deletion",
      result,
      publication,
    };
    return transferSessionEntryWorkerCandidate(database, context.admit, candidate, wrapReceipt);
  };
  return input.nativeBindings
    ? runSessionNativeBindingTransaction(
        input.nativeBindings,
        context,
        "session.lifecycle.delete",
        "Session entry deletion",
        mutate,
      )
    : context.writeTransaction("session.lifecycle.delete", "Session entry deletion", (database) =>
        mutate(database, (receipt) => receipt),
      );
}
