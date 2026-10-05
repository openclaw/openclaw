import { isDeepStrictEqual } from "node:util";
import { resolveStateDir } from "../../config/paths.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import {
  readUpdateStateSchemaVersions,
  updateStateSchemaVersionsMatch,
} from "../../infra/update-candidate-state.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { readUpgradeRecipeMaintenanceReceipt } from "../../infra/upgrade-recipes/maintenance.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { runUpgradeRecipeTargetMaintenance } from "./recipe-maintenance-target.js";
import {
  prepareRecipeTargetMaintenance,
  reconcileRecipePackagePublication,
  reconcileRecipeTargetMaintenance,
  prepareRecipeServiceActivation,
  reconcileRecipeServiceActivation,
} from "./recipe-step-execution.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import type { prepareUpdateRestart } from "./update-command-restart-context.js";
import type { UpdateServiceDefinitionRecovery } from "./update-command-service-context-types.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";
import { maybeRestartService } from "./update-command-service.js";
import {
  assertRecipeUpdateBinding,
  assertRecipeUpdateConfig,
  verifyRecipeUpdateConfig,
  verifyRecipeUpdateInstallation,
} from "./update-recipe-context.js";

/** Installed target finalization under the same original native owner and writer. */
export async function prepareRecipeUpdateFinalization({
  params,
  postUpdateRoot,
  shouldRestart,
  restartContext,
  configSnapshot,
  assertCurrent,
  onGatewayStartAttempted,
  onVerified,
}: {
  params: FinishUpdateParams;
  postUpdateRoot: string;
  shouldRestart: boolean;
  restartContext: Awaited<ReturnType<typeof prepareUpdateRestart>>;
  configSnapshot: ConfigFileSnapshot;
  assertCurrent: () => void;
  onGatewayStartAttempted: () => void;
  onVerified: (verifiedAtMs: number) => void;
}) {
  const recipe = params.opts.recipe;
  if (!recipe) {
    return undefined;
  }
  const originalRun = params.opts.run;
  const executor = originalRun?.executorFence;
  assertRecipeUpdateBinding(recipe, postUpdateRoot, originalRun?.runId, executor);
  if (
    !originalRun ||
    !executor ||
    !shouldRestart ||
    !restartContext.serviceMutationAllowed ||
    restartContext.skipLegacyServiceRestart ||
    restartContext.serviceUpdateVerdict?.kind !== "owned"
  ) {
    throw new Error(
      "Recipe completion requires its original executor and an owned verifiable managed service restart.",
    );
  }
  assertRecipeUpdateConfig(recipe, configSnapshot);
  const env = params.ownedManagedUpdateEnv ?? originalRun.env;
  const receiptGuards = createUpdateCommandExecutionGuards(params.opts, postUpdateRoot);
  // This is the installed target finalizer, after native schema handoff. Its
  // writer remains guarded by the original executor, not a receipt-derived grant.
  receiptGuards.onStateHandoff();
  const receiptWriteOptions = receiptGuards.captureWriteOptions();
  const assertReceiptOwner = () => {
    receiptWriteOptions.assertCurrent();
    assertCurrent();
  };
  const recipeReceiptOwner = {
    ...receiptWriteOptions,
    env,
    assertCurrent: assertReceiptOwner,
    assertEffectsSettled: assertReceiptOwner,
  };
  await reconcileRecipePackagePublication(recipe, recipeReceiptOwner);
  const verifyTarget = async () => {
    await verifyRecipeUpdateInstallation(recipe, postUpdateRoot, "target");
    await verifyRecipeUpdateConfig(recipe, env);
    assertCurrent();
  };
  await verifyTarget();
  const receipt = await readUpgradeRecipeMaintenanceReceipt({ env });
  assertCurrent();
  if (!receipt || !isDeepStrictEqual(receipt.binding, recipe.maintenance.binding)) {
    throw new Error("Recipe target maintenance lacks its exact prepublication durable binding.");
  }
  // A delegated commit can cross COMMIT_INTENT even if its reply is lost.
  // Both compensation and the waiting source driver must preserve current state.
  params.rollbackBlockedReason = "state-migrated-no-rollback";
  onGatewayStartAttempted();
  if (receipt.phase !== "committed") {
    await prepareRecipeTargetMaintenance(recipe, recipeReceiptOwner);
    await runUpgradeRecipeTargetMaintenance({
      recipe,
      fence: executor,
      input: recipe.maintenance,
      env,
      verifyTarget,
    });
    assertCurrent();
  } else {
    const current = await readUpdateStateSchemaVersions({
      root: postUpdateRoot,
      nodeRunner: recipe.maintenance.expected.runtimeExecutable,
      stateDir: resolveStateDir(env),
      config: configSnapshot.config,
      env,
      timeoutMs: params.updateStepTimeoutMs,
    });
    assertCurrent();
    if (
      !updateStateSchemaVersionsMatch(recipe.maintenance.stateVersions, current, {
        sharedPath: resolveOpenClawStateSqlitePath(env),
      })
    ) {
      throw new Error(
        "Committed recipe recovery cannot verify the current target state contracts.",
      );
    }
  }
  await verifyTarget();
  await reconcileRecipeTargetMaintenance(recipe, recipeReceiptOwner);
  await prepareRecipeServiceActivation(recipe, recipeReceiptOwner);

  let verifiedByNativeOwner = false;
  return {
    restartCallbacks: {
      expectedGatewayIdentity: {
        version: recipe.maintenance.expected.version,
        buildId: recipe.maintenance.expected.buildId,
      },
      onVerified: (verifiedAtMs: number) => {
        verifiedByNativeOwner = true;
        onVerified(verifiedAtMs);
      },
    },
    completeService: () =>
      reconcileRecipeServiceActivation(recipe, recipeReceiptOwner, verifiedByNativeOwner),
  };
}

/** Keep the exact finalization selectors in the existing managed-service owner. */
export async function restartPostUpdateGateway({
  params,
  restartContext,
  result,
  shouldRestart,
  definitionRecovery,
  requireRunningServiceAfterRestart,
  callbacks,
}: {
  params: FinishUpdateParams;
  restartContext: Awaited<ReturnType<typeof prepareUpdateRestart>>;
  result: UpdateRunResult;
  shouldRestart: boolean;
  definitionRecovery: UpdateServiceDefinitionRecovery;
  requireRunningServiceAfterRestart: boolean;
  callbacks: Pick<
    Parameters<typeof maybeRestartService>[0],
    | "onGatewayStartAttempted"
    | "onVerificationFailure"
    | "onPluginWarnings"
    | "onVerified"
    | "expectedGatewayIdentity"
  >;
}) {
  return withOwnedManagedUpdateEnv(params.ownedManagedUpdateEnv, () =>
    maybeRestartService({
      originalManagedServiceRuntime: params.originalManagedServiceRuntime,
      shouldRestart: shouldRestart && restartContext.serviceMutationAllowed,
      result,
      opts: params.opts,
      refreshServiceEnv: restartContext.refreshGatewayServiceEnv,
      definitionRecovery,
      serviceUpdateVerdict: restartContext.serviceUpdateVerdict,
      serviceManagerUid: restartContext.serviceManagerUid,
      serviceRuntimeRefreshRequired: params.serviceRuntimeRefreshRequired,
      serviceEnv: restartContext.gatewayServiceEnv,
      serviceInstallEnv: restartContext.gatewayServiceInstallEnv,
      gatewayPort: restartContext.gatewayPort,
      invocationCwd: params.invocationCwd,
      nodeRunner: params.packageUpdateNodeRunner,
      skipLegacyServiceRestart: restartContext.skipLegacyServiceRestart,
      requireRunningServiceAfterRestart,
      serviceMutationSkipMessage: restartContext.serviceMutationSkipMessage,
      timeoutMs: params.updateStepTimeoutMs,
      ...callbacks,
    }),
  );
}
