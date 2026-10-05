import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import {
  assertUpgradeRecipeCatalogCurrent,
  type AuthenticatedUpgradeRecipeCatalog,
} from "../../infra/upgrade-recipes/catalog.js";
import { validateUpgradeReleaseQualification } from "../../infra/upgrade-recipes/qualification.js";
import { assertReleaseQualificationCustody } from "./recipe-first-qualification.js";
import { captureUpdateCommandExecutorAuthority } from "./update-command-executor.js";
import {
  resolveAuthenticatedRecipeUpdateCatalog,
  verifyRecipeUpdateRunner,
  type RecipeUpdateArtifactSelectors,
  type RecipeUpdateContext,
} from "./update-recipe-context.js";

/** Actual signed qualification evidence; catalog advertisement alone is not an upgrade proof. */
export async function verifyRecipeQualificationEvidence(
  recipe: Pick<
    RecipeUpdateArtifactSelectors,
    | "sourceReleaseId"
    | "targetReleaseId"
    | "artifactsDirectory"
    | "route"
    | "releaseQualification"
    | "catalog"
    | "runner"
    | "localArchivePath"
    | "maintenance"
  >,
  catalog: AuthenticatedUpgradeRecipeCatalog,
): Promise<void> {
  if (recipe.releaseQualification) {
    await assertReleaseQualificationCustody(recipe, catalog);
    const route = catalog.catalog.recipes.find(
      (entry) =>
        entry.id === recipe.route.recipe.id && entry.revision === recipe.route.recipe.revision,
    );
    if (route?.purpose !== "production" || recipe.route.qualificationId !== undefined) {
      throw new Error(
        "First qualification is not production evidence and cannot adopt a prior qualification claim.",
      );
    }
    return;
  }
  await verifyRecipeUpdateRunner(recipe, catalog);
  const qualification = catalog.catalog.qualifications.find(
    (entry) => entry.id === recipe.route.qualificationId,
  );
  const artifact = catalog.catalog.artifacts.find(
    (entry) => entry.id === qualification?.evidenceArtifactId,
  );
  if (!artifact || artifact.length > 8 * 1024 * 1024) {
    throw new Error("Recipe lacks bounded authenticated historical qualification evidence.");
  }
  const filename = path.join(recipe.artifactsDirectory, artifact.id);
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size !== artifact.length ||
      (before.mode & 0o077) !== 0 ||
      (process.getuid && before.uid !== process.getuid())
    ) {
      throw new Error("Recipe qualification evidence has changed or is not owner-private.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const named = await fs.lstat(filename);
    if (
      bytes.length !== artifact.length ||
      createHash("sha256").update(bytes).digest("hex") !== artifact.sha256 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.ctimeMs !== after.ctimeMs ||
      before.mtimeMs !== after.mtimeMs ||
      named.dev !== after.dev ||
      named.ino !== after.ino
    ) {
      throw new Error(
        "Recipe qualification evidence differs from its exact authenticated artifact.",
      );
    }
    validateUpgradeReleaseQualification({
      catalog: catalog.catalog,
      evidence: JSON.parse(bytes.toString("utf8")),
      changedContracts: [],
      dispositions: [],
    });
  } finally {
    await handle.close();
  }
}

/** Admit only the fixed startup pause, before delegation suspends the parent fence. */
export async function admitReleaseQualificationChildInspector(
  recipe: RecipeUpdateContext,
  fence: UpdateRecoveryFence,
): Promise<string | undefined> {
  const flag = "--inspect-brk=127.0.0.1:0";
  if (!process.execArgv.includes(flag)) {
    return undefined;
  }
  if (!recipe.releaseQualification || process.execArgv.length !== 1) {
    throw new Error("Target startup inspection requires exact release qualification custody.");
  }
  const { runId, installationKey } = recipe.maintenance.binding;
  const original = captureUpdateCommandExecutorAuthority(fence, runId);
  if (original.installKey !== installationKey) {
    throw new Error("Target startup inspection changed its original installation.");
  }
  // This canonical resolver revalidates signed release qualification custody,
  // including runner bytes, machine identity and the live admitted receiver.
  const catalog = await resolveAuthenticatedRecipeUpdateCatalog(recipe);
  assertUpgradeRecipeCatalogCurrent(catalog);
  const current = captureUpdateCommandExecutorAuthority(fence, runId);
  if (current !== original || current.installKey !== installationKey) {
    throw new Error("Target startup inspection changed its original executor.");
  }
  fence.assertCurrent();
  if (process.execArgv.length !== 1 || process.execArgv[0] !== flag) {
    throw new Error("Target startup inspection observation changed during admission.");
  }
  return flag;
}
