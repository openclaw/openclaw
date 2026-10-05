import { isDeepStrictEqual } from "node:util";
import { assertUpgradeRecipeCapacityInputs } from "../../infra/upgrade-recipes/execution-capacity.js";
import { createUpgradeRecipeMaintenanceOwner } from "../../infra/upgrade-recipes/maintenance.js";
import { prepareRecipePackagePublication } from "./recipe-step-execution.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";
import {
  assertRecipeUpdateBinding,
  assertRecipeUpdateEnvironment,
  assertRecipeUpdatePackageOwner,
  verifyRecipeUpdateArchive,
  verifyRecipeUpdateConfig,
  verifyRecipeUpdateInstallation,
} from "./update-recipe-context.js";

export async function verifyRecipeExecutionSelection(
  params: MutableUpdateExecutionParams,
): Promise<void> {
  const { opts } = params;
  const assertExecutionCurrent = params.executionGuards.assertCurrent;
  if (opts.recipe) {
    assertRecipeUpdateEnvironment(opts.recipe, opts.run?.env ?? process.env);
    assertRecipeUpdatePackageOwner(opts.recipe, params.packageInstallTarget);
    assertRecipeUpdateBinding(opts.recipe, params.root, opts.run?.runId, opts.run?.executorFence);
    if (
      params.updateInstallKind !== "package" ||
      params.switchToGit ||
      !params.shouldRestart ||
      params.packageInstallSpec !== opts.recipe.localArchivePath ||
      params.legacyConfigPlan
    ) {
      throw new Error(
        "Recipe package execution cannot substitute installation, artifact, config repair, or restart policy.",
      );
    }
    await verifyRecipeUpdateArchive(opts.recipe);
    await verifyRecipeUpdateConfig(opts.recipe, opts.run?.env ?? process.env);
    assertExecutionCurrent();
  }
}

/** Admit the captured service environment before it becomes the recovery target. */
export async function verifyRecipeManagedEnvironment(
  params: MutableUpdateExecutionParams,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (params.opts.recipe) {
    assertRecipeUpdateEnvironment(params.opts.recipe, env);
    await verifyRecipeUpdateConfig(params.opts.recipe, env);
    params.executionGuards.assertCurrent();
  }
}

export async function verifyRecipeCandidateBoundary(
  params: MutableUpdateExecutionParams,
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (params.opts.recipe) {
    await verifyRecipeUpdateInstallation(params.opts.recipe, root, "target");
    await verifyRecipeUpdateConfig(params.opts.recipe, env);
    params.executionGuards.assertCurrent();
  }
}

/** Persist exclusion before phase advancement or service stop, so a crash retains a recovery owner. */
export async function requireRecipePreactivationMaintenance(
  params: MutableUpdateExecutionParams,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!params.opts.recipe) {
    return;
  }
  const owner = createUpgradeRecipeMaintenanceOwner(params.opts.recipe.maintenance.binding, {
    ...params.executionGuards.captureWriteOptions(),
    env,
    assertCurrent: params.executionGuards.assertCurrent,
  });
  const current = await owner.read();
  owner.assertCurrent();
  if (current && isDeepStrictEqual(current.binding, owner.binding)) {
    if (current.phase !== "maintenance-required") {
      throw new Error("Recipe preparation cannot cross its retained maintenance commit.");
    }
    return;
  }
  if (current && current.phase !== "committed") {
    throw new Error("Recipe preparation cannot replace another pending maintenance owner.");
  }
  await owner.requireMaintenance(current?.revision ?? null);
  owner.assertCurrent();
}

export async function prepareRecipePublicationBoundary(
  params: MutableUpdateExecutionParams,
  validatedCandidateRoot: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const { opts } = params;
  const { assertCurrent: assertExecutionCurrent, captureWriteOptions } = params.executionGuards;
  if (opts.recipe) {
    assertRecipeUpdatePackageOwner(opts.recipe, params.packageInstallTarget);
    assertRecipeUpdateBinding(opts.recipe, params.root, opts.run?.runId, opts.run?.executorFence);
    await verifyRecipeUpdateArchive(opts.recipe);
    await verifyRecipeUpdateConfig(opts.recipe, env);
    await verifyRecipeUpdateInstallation(opts.recipe, validatedCandidateRoot!, "target");
    assertExecutionCurrent();
    await assertUpgradeRecipeCapacityInputs(opts.recipe.planningEvidence.executionCapacity, {
      installationRoot: params.root,
      candidateRoot: validatedCandidateRoot,
      runnerRoot: opts.recipe.runner.root,
      archivePath: opts.recipe.localArchivePath,
      stateRoot: opts.recipe.maintenance.expected.stateRoot,
    });
    assertExecutionCurrent();
    const owner = createUpgradeRecipeMaintenanceOwner(opts.recipe.maintenance.binding, {
      ...captureWriteOptions(),
      assertCurrent: assertExecutionCurrent,
    });
    const current = await owner.read();
    assertExecutionCurrent();
    if (
      !current ||
      current.phase !== "maintenance-required" ||
      !isDeepStrictEqual(current.binding, opts.recipe.maintenance.binding)
    ) {
      throw new Error(
        "Recipe publication cannot overwrite retained maintenance; resume its original owner.",
      );
    }
    const receiptWriteOptions = captureWriteOptions();
    const assertReceiptOwner = () => {
      receiptWriteOptions.assertCurrent();
      assertExecutionCurrent();
    };
    await prepareRecipePackagePublication(opts.recipe, {
      ...receiptWriteOptions,
      env,
      assertCurrent: assertReceiptOwner,
      assertEffectsSettled: assertReceiptOwner,
    });
    assertExecutionCurrent();
  }
}
