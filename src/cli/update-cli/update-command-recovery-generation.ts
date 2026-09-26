import { isDeepStrictEqual } from "node:util";
import type { PackageActivationReversePreparation } from "../../infra/package-update-activation-reverse-schema.js";
import type { PackageReverseAuthority } from "../../infra/package-update-activation-reverse.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-swap-contract.js";
import type { UpdateRecoveryBackupRef } from "../../infra/update-recovery-backup-contract.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import {
  captureOpenClawDatabaseMaintenanceAdmission,
  getOpenClawDatabaseMaintenanceScope,
  type OpenClawDatabaseMaintenanceScope,
} from "../../state/openclaw-state-db-async-lifecycle.js";
import {
  captureUpdateCommandExecutorCurrentStores,
  captureUpdateCommandRecoveryGenerationAuthority,
  publishUpdateCommandRecoveryGeneration,
} from "./update-command-executor.js";

/** Already prepared by the original capture/resource owners, never a baseline-only
 * restore request. The maintenance scope must remain held by the caller through
 * completion and subsequent reader admission. This value is not serializable authority. */
export type UpdateCommandRecoveryGenerationInput = {
  binding: PackageActivationReversePreparation;
  maintenance: OpenClawDatabaseMaintenanceScope;
  assertWritersSettled: () => void;
  assertCapturedSource: NonNullable<PackageReverseAuthority["assertCapturedSource"]>;
  validateTarget: PackageReverseAuthority["validateTarget"];
};

/** The real rollback caller enters selected-original startup before publication.
 * No owner is acquired here, and no filesystem observation manufactures identity. */
export async function publishOriginalUpdateRecoveryGeneration(params: {
  generation: UpdateCommandRecoveryGenerationInput;
  baseline: UpdateRecoveryBackupRef;
  /** Identity/native-lock checks only; never the retired reader-facing fence. */
  assertCallerBindings: () => void;
  transaction: PackageUpdateTransaction;
  executor: UpdateRecoveryFence;
  runId: string;
  timeoutMs: number;
}) {
  const { executor, runId } = params;
  const assertOriginal = captureUpdateCommandRecoveryGenerationAuthority(executor, runId);
  const initial = captureUpdateCommandExecutorCurrentStores(executor, runId);
  if (!initial) {
    throw new Error("Recovery requires its admitted initial stores.");
  }
  const maintenance = params.generation.maintenance;
  const assertMaintenance = captureOpenClawDatabaseMaintenanceAdmission(maintenance);
  const assertWritersSettled = params.generation.assertWritersSettled.bind(params.generation);
  const assertCapturedSource = params.generation.assertCapturedSource.bind(params.generation);
  const validateTarget = params.generation.validateTarget.bind(params.generation);
  const binding = structuredClone(params.generation.binding);
  const baseline = structuredClone(params.baseline);
  const assertCallerBindings = params.assertCallerBindings.bind(params);
  if (!isDeepStrictEqual(binding.baseline, baseline)) {
    throw new Error("Recovery changed its retained baseline capture.");
  }
  const publication = params.transaction.reversePublication;
  if (!publication || binding.runId !== runId) {
    throw new Error("Recovery requires its original run and reverse package transaction.");
  }
  const original = {
    selection: publication.selection.bind(publication),
    resourceCustody: publication.resourceCustody.bind(publication),
    prepare: publication.prepare.bind(publication),
    publish: publication.publish.bind(publication),
    settle: publication.settle.bind(publication),
    verifyCompletion: publication.verifyCompletion.bind(publication),
    commitCompletion: publication.commitCompletion.bind(publication),
  };
  const selected = structuredClone(original.selection());
  const assertHeld = () => {
    assertCallerBindings();
    assertMaintenance();
    if (getOpenClawDatabaseMaintenanceScope() !== maintenance) {
      throw new Error("Recovery lost its original maintenance scope.");
    }
    assertWritersSettled();
  };
  const assertOwned = () => {
    assertOriginal();
    assertHeld();
    if (
      selected.operationId !== binding.operationId ||
      selected.originalRunId !== runId ||
      !isDeepStrictEqual(selected, original.selection())
    ) {
      throw new Error("Recovery changed its original operation or selected runtime.");
    }
  };
  assertOwned();
  // The retained executor supplies its own continuing authority after retirement.
  // Do not call the old reader-facing fence from inside the publication callback.
  const completion = await publishUpdateCommandRecoveryGeneration(executor, runId, {
    binding,
    transaction: { ...params.transaction, reversePublication: original },
    maintenance,
    assertWritersSettled: assertHeld,
    validateTarget,
    assertCapturedSource,
  });
  assertOwned();
  const current = captureUpdateCommandExecutorCurrentStores(executor, runId);
  if (
    !current ||
    !isDeepStrictEqual(current.selection.privateRoot, initial.selection.privateRoot) ||
    !isDeepStrictEqual(current.selection.handoff, initial.selection.handoff) ||
    !isDeepStrictEqual(current.selection.state, completion.publishedState.state)
  ) {
    throw new Error("Recovery lost its verified current store admission.");
  }
  return completion;
}
