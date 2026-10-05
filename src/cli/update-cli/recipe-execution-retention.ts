import { createConfigIO } from "../../config/io.factory.js";
import { readUpdateRecoveryBaselineIdentity } from "../../infra/update-recovery-backup-reader.js";
import type { UpdateRecoveryBaselineRef } from "../../infra/update-recovery-baseline-capture.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { getUpdateRunForProgressAsync } from "../../infra/update-run-reader.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { UpdateRunWriteOptions } from "../../infra/update-run-write.async.js";
import { createRetainedUpgradeRecipeRunStore } from "../../infra/upgrade-recipes/retained-run.js";
import { resolveRecipeStepBinding } from "./recipe-step-execution.js";
import {
  assertRecipeUpdateBinding,
  assertRecipeUpdateConfig,
  assertRecipeUpdateEnvironment,
  RECIPE_UPDATE_BUILTIN_ACTIONS,
  resolveAuthenticatedRecipeUpdateCatalog,
  verifyRecipeUpdateRunner,
  type RecipeUpdateContext,
} from "./update-recipe-context.js";

/** Retain reconstruction evidence under the original native owner before live mutation. */
export async function retainRecipeExecution(
  recipe: RecipeUpdateContext,
  fence: UpdateRecoveryFence,
  options: UpdateRunWriteOptions & {
    env: NodeJS.ProcessEnv;
    assertCurrent: () => void;
    originalRecoveryCapture?: UpdateRecoveryBaselineRef;
  },
): Promise<void> {
  const { runId } = recipe.maintenance.binding;
  const assertCurrent = () => {
    options.assertCurrent();
    fence.assertCurrent();
  };
  assertRecipeUpdateBinding(recipe, recipe.maintenance.expected.installationRoot, runId, fence);
  assertRecipeUpdateEnvironment(recipe, options.env);
  assertCurrent();
  const run = await getUpdateRunForProgressAsync(runId, options, options.signal);
  assertCurrent();
  if (!run || run.status !== "running") {
    throw new Error("Recipe retention requires its exact original running ledger owner.");
  }
  const original = options.originalRecoveryCapture;
  if (!original) {
    throw new Error(
      "Recipe execution requires its verified original recovery capture before mutation.",
    );
  }
  await readUpdateRecoveryBaselineIdentity({
    runId,
    env: options.env,
    ref: original,
    installRoot: recipe.maintenance.expected.installationRoot,
    readContinuation: () => getUpdateRun(runId, { env: options.env }),
    assertCurrent,
  });
  assertCurrent();
  const snapshot = await createConfigIO({
    configPath: recipe.maintenance.expected.configPath,
    env: options.env,
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshot();
  assertCurrent();
  assertRecipeUpdateConfig(recipe, snapshot);
  const catalog = await resolveAuthenticatedRecipeUpdateCatalog(recipe);
  assertCurrent();
  if (catalog.digest !== recipe.catalogDigest) {
    throw new Error("Recipe retention cannot adopt a new catalog generation.");
  }
  const runner = await verifyRecipeUpdateRunner(recipe, catalog);
  assertCurrent();
  const stepBindings = [];
  for (const action of RECIPE_UPDATE_BUILTIN_ACTIONS) {
    stepBindings.push(await resolveRecipeStepBinding(recipe, action.id));
    assertCurrent();
  }
  await createRetainedUpgradeRecipeRunStore({ ...options, assertCurrent }).retain({
    fence,
    runId,
    originalCreatedAtMs: run.createdAtMs,
    root: recipe.artifactsDirectory,
    forbiddenRoots: recipe.catalog.forbiddenRoots,
    envelope: {
      schemaVersion: 1,
      binding: recipe.maintenance.binding,
      originalRecoveryCapture: {
        directory: original.directory,
        manifestPath: original.manifestPath,
        manifestSha256: original.manifestSha256,
      },
      runner: {
        root: runner.root,
        manifestDigest: runner.manifestDigest,
        closureDigest: runner.closureDigest,
        runtimePath: runner.runtimePath,
        entrypointPath: recipe.releaseQualification
          ? runner.releaseQualificationEntrypointPath!
          : runner.entrypointPath,
      },
      stepBindings,
    },
    plan: Buffer.from(JSON.stringify(recipe)),
    config: Buffer.from(
      JSON.stringify({
        path: snapshot.path,
        hash: snapshot.hash,
        sourceConfig: snapshot.sourceConfig,
      }),
    ),
    authorization: Buffer.from(JSON.stringify(catalog)),
  });
  assertCurrent();
}
