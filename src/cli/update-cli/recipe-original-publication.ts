import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  inspectPackageActivationCustody,
  packageActivationIdentityOrAbsent,
} from "../../infra/package-update-activation-custody.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
} from "../../infra/package-update-activation-journal.js";
import { createPackageIntegrityReader } from "../../infra/package-update-integrity.js";
import { createPublicationOwner } from "../../infra/package-update-publication-owner.js";
import type { RetainedUpgradeRecipeRun } from "../../infra/upgrade-recipes/recovery.js";
import {
  verifyRecipeUpdateInstallation,
  type RecipeUpdateContext,
} from "./update-recipe-context.js";

/** Passive native-journal admission plus authenticated target inspection, not version-only adoption. */
export async function inspectOriginalRecipePackagePublication(options: {
  retained: RetainedUpgradeRecipeRun;
  recipe: RecipeUpdateContext;
  assertCurrent: () => void;
}) {
  const { retained, recipe, assertCurrent } = options;
  assertCurrent();
  if (!isDeepStrictEqual(retained.binding, recipe.maintenance.binding)) {
    throw new Error("Recipe publication inspection differs from its retained original approval.");
  }
  const anchor = resolvePackageActivationAnchor(retained.binding.installationKey);
  const journal = openPackageActivationJournal(anchor);
  const admission = await journal.readForRecovery();
  assertCurrent();
  const record = admission.record;
  if (
    !isDeepStrictEqual(record.descriptor.authority, {
      ...retained.nativeAuthority,
      owner: retained.originalNativeOwner,
    })
  ) {
    throw new Error("Recipe publication inspection refuses a foreign original native owner.");
  }
  const owner = createPublicationOwner(
    anchor,
    journal,
    assertCurrent,
    record,
    admission.assertUnchanged,
  );
  const retirement = record.phase === "retiring" || record.phase === "anchor-retired";
  if (retirement) {
    await owner.assertCandidateRetirement();
  } else {
    await owner.preflight("repair");
  }
  assertCurrent();
  const locations =
    record.phase === "preparing"
      ? inspectPackageActivationCustody(anchor, record)
          .filter((entry) => entry.name === "candidate")
          .map((entry) => (entry.moved ? entry.destination : entry.source))
      : [retained.binding.installationKey, path.join(anchor, "candidate")];
  const candidates = locations.filter(
    (location) =>
      packageActivationIdentityOrAbsent(location, true) === record.descriptor.candidate.identity,
  );
  if (candidates.length !== 1) {
    throw new Error("Recipe publication lost its unique original candidate custody.");
  }
  const candidateRoot = candidates[0]!;
  await verifyRecipeUpdateInstallation(recipe, candidateRoot, "target");
  assertCurrent();
  const actual = await createPackageIntegrityReader(recipe.maintenance.timeoutMs).tree(
    candidateRoot,
    record.descriptor.originalStageRoot,
  );
  assertCurrent();
  admission.assertUnchanged();
  if (!isDeepStrictEqual(actual, record.descriptor.candidate)) {
    throw new Error(
      "Recipe authenticated candidate differs from its original native journal tree.",
    );
  }
  return {
    operationId: record.descriptor.operationId,
    expectedCandidate: actual,
    phase: record.phase,
    retirementComplete: owner.status().phase === "complete",
    candidateRoot,
  };
}
