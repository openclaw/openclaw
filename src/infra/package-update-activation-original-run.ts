import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { captureUpdateCommandExecutorAuthority } from "../cli/update-cli/update-command-executor.js";
import {
  openPackageActivationJournal,
  assertPackageActivationOperation,
  assertPackageActivationLayout,
  resolvePackageActivationAnchor,
} from "./package-update-activation-journal.js";
import type { PackageActivationDescriptor } from "./package-update-activation-schema.js";
import { createPublicationOwner } from "./package-update-publication-owner.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import { assertManagedUpdateLeaseDatabaseIdentity } from "./update-managed-service-handoff-database.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";
import type { RetainedUpgradeRecipeRun } from "./upgrade-recipes/recovery.js";

/** Continue the original publication only. Durable correlation never replaces live native custody.
 * expectedCandidate must come from original owner evidence plus authenticated target inspection,
 * not from an arbitrary journal adopted by this helper or a matching package version.
 */
export async function reconcileOriginalRunPackagePublication(options: {
  fence: UpdateRecoveryFence;
  retained: Pick<RetainedUpgradeRecipeRun, "binding" | "nativeAuthority" | "originalNativeOwner">;
  operationId: string;
  expectedCandidate: PackageActivationDescriptor["candidate"];
  /** Only after original source, maintenance, and snapshot owners admit progression. */
  continuePreparation?: boolean;
  onDisplaced?: () => Promise<void>;
}) {
  const runId = z.uuid().parse(options.retained.binding.runId);
  const retained = structuredClone(options.retained);
  const expectedCandidate = structuredClone(options.expectedCandidate);
  const operationId = z.uuid().parse(options.operationId);
  if (retained.binding.installationKey !== retained.nativeAuthority.installKey) {
    throw new Error("Original publication selects another installation.");
  }
  const captured = captureUpdateCommandExecutorAuthority(options.fence, runId);
  const { owner: _currentOwner, ...identity } = captured;
  if (!isDeepStrictEqual(identity, retained.nativeAuthority)) {
    throw new Error("Original publication differs from its admitted native control store.");
  }
  let completionAssertion = () => {};
  const assertCurrent = () => {
    options.fence.assertCurrent();
    completionAssertion();
    if (!isDeepStrictEqual(captureUpdateCommandExecutorAuthority(options.fence, runId), captured)) {
      throw new Error("Original publication executor authority changed.");
    }
    assertManagedUpdateLeaseDatabaseIdentity(retained.nativeAuthority);
  };
  assertCurrent();
  const anchor = resolvePackageActivationAnchor(retained.nativeAuthority.installKey);
  assertPackageActivationLayout(anchor);
  const journal = openPackageActivationJournal(anchor);
  const admission = await journal.readForRecovery();
  assertCurrent();
  const initial = admission.record;
  assertPackageActivationOperation(initial, operationId);
  if (
    !isDeepStrictEqual(initial.descriptor.authority, {
      ...retained.nativeAuthority,
      owner: retained.originalNativeOwner,
    })
  ) {
    throw new Error("Publication journal belongs to a foreign original update owner.");
  }
  if (!isDeepStrictEqual(initial.descriptor.candidate, expectedCandidate)) {
    throw new Error("Publication journal differs from the exact original candidate.");
  }
  const retirement = initial.phase === "retiring" || initial.phase === "anchor-retired";
  if (
    !retirement &&
    !["preparing", "prepared", "publishing", "publication-complete"].includes(initial.phase)
  ) {
    throw new Error(
      "Original publication is disarmed; never restore, retire, or rewind automatically.",
    );
  }
  // Passive recovered-journal observations do not acquire authority or select another operation.
  const passiveOwner = createPublicationOwner(
    anchor,
    journal,
    assertCurrent,
    initial,
    admission.assertUnchanged,
  );
  if (retirement) {
    await passiveOwner.assertCandidateRetirement();
  } else {
    await passiveOwner.preflight("repair");
    if (!options.continuePreparation) {
      await passiveOwner.assertPublicationStarted();
    }
  }
  assertCurrent();
  admission.admit(assertCurrent);
  journal.assertCurrent(initial);
  const owner = createPublicationOwner(anchor, journal, assertCurrent, initial);
  if (!retirement && !options.continuePreparation) {
    await owner.assertPublicationStarted();
  }
  const status = retirement
    ? owner.status()
    : await owner.publish(!options.continuePreparation, options.onDisplaced);
  assertCurrent();
  if (!retirement && status.phase !== "publication-complete") {
    throw new Error(
      "Native original publication reconciliation did not select the target; preserve its retained journal for the original owner.",
    );
  }
  let completion: Promise<void> | undefined;
  const transaction: PackageUpdateTransaction = {
    backupRoot: path.join(anchor, "previous"),
    assertRollbackSafe: async () => {
      assertCurrent();
      throw new Error("Original-run recipe recovery never authorizes automatic package rollback.");
    },
    rollback: async (assertion) => {
      assertion();
      assertCurrent();
      throw new Error(
        "Original-run recipe recovery preserves current package and journal; rollback requires its separate owner.",
      );
    },
    complete: async (outcome, assertion) => {
      assertion();
      assertCurrent();
      if (!outcome.activationVerified) {
        throw new Error(
          "Original publication evidence must remain until actual activation is verified.",
        );
      }
      completionAssertion = assertion;
      // Existing finishUpdate explicitly confirms readiness before selecting native retirement.
      completion ??= (async () => {
        assertCurrent();
        await owner.assertCandidateRetirement();
        assertCurrent();
        await owner.retire();
        assertCurrent();
      })();
      await completion;
    },
  };
  return { anchor, operationId, status, transaction };
}
