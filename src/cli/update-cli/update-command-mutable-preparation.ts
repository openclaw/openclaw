import {
  canResolveRegistryVersionForPackageTarget,
  type ResolvedGlobalInstallTarget,
} from "../../infra/update-global.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { retainRecipeExecution } from "./recipe-execution-retention.js";
import { inspectUpdateDatabaseContexts } from "./update-command-database-context.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";

export function mutableUpdatePreflightOptions(params: MutableUpdateExecutionParams) {
  const { opts, updateStepTimeoutMs } = params;
  const candidateAdmissionChecks =
    params.updateInstallKind === "package" ? opts.run?.candidateAdmissionChecks : undefined;
  const configValidation = candidateAdmissionChecks?.includes("config")
    ? ("candidate" as const)
    : undefined;
  const mode: UpdateRunResult["mode"] =
    params.updateInstallKind === "git"
      ? "git"
      : (params.packageInstallTarget?.manager ?? "unknown");
  const stagedPluginAdmission =
    params.updateInstallKind === "package" &&
    !canResolveRegistryVersionForPackageTarget(params.packageInstallSpec ?? params.tag);
  const databaseContextOptions = {
    ...params,
    updateInstallKind: params.updateInstallKind === "git" ? "git" : "package",
    jsonMode: Boolean(opts.json),
    timeoutMs: updateStepTimeoutMs,
    candidateAdmissionChecks,
  } satisfies Omit<Parameters<typeof inspectUpdateDatabaseContexts>[0], "roots">;
  return {
    candidateAdmissionChecks,
    configValidation,
    databaseContextOptions,
    mode,
    stagedPluginAdmission,
  };
}

/** Retain the original recipe evidence immediately after native preparation, before live effects. */
export function createMutableUpdatePreparation(
  params: MutableUpdateExecutionParams,
  getInstallTarget: () => ResolvedGlobalInstallTarget | undefined,
) {
  const { opts } = params;
  const {
    assertCurrent: assertExecutionCurrent,
    admitExecutor,
    captureWriteOptions,
  } = params.executionGuards;
  let recipeRetained = false;
  return async (env?: NodeJS.ProcessEnv, activationTimeoutMs?: number) => {
    assertExecutionCurrent();
    await params.prepareMutableUpdate(env, activationTimeoutMs, admitExecutor, getInstallTarget());
    assertExecutionCurrent();
    if (opts.recipe && !recipeRetained) {
      const fence = opts.run?.executorFence;
      if (!fence) {
        throw new Error("Recipe retention requires native executor admission.");
      }
      await retainRecipeExecution(opts.recipe, fence, {
        ...captureWriteOptions(),
        env: env ?? opts.run?.env ?? process.env,
        originalRecoveryCapture: opts.run?.originalRecoveryCapture,
        assertCurrent: assertExecutionCurrent,
      });
      assertExecutionCurrent();
      recipeRetained = true;
    }
  };
}
