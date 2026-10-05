import path from "node:path";
import { z } from "zod";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { upgradeRecipeMaintenanceReceiptSchema } from "../../infra/upgrade-recipes/maintenance-contract.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { admitReleaseQualificationChildInspector } from "./recipe-qualification.js";
import {
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import type { RecipeUpdateContext } from "./update-recipe-context.js";
import {
  UPDATE_RECIPE_MAINTENANCE_CAPABILITY,
  type UpdateRecipeMaintenanceInput,
} from "./update-recipe-maintenance-contract.js";

const resultSchema = z.strictObject({
  capability: z.literal(UPDATE_RECIPE_MAINTENANCE_CAPABILITY),
  outcome: z.literal("target-committed"),
  managedServiceVerified: z.literal(false),
  receipt: upgradeRecipeMaintenanceReceiptSchema,
});

/** Reuse native child custody; target receipts do not authorize a separate executor. */
export async function runUpgradeRecipeTargetMaintenance(options: {
  fence: UpdateRecoveryFence;
  recipe: RecipeUpdateContext;
  input: Omit<UpdateRecipeMaintenanceInput, "executor" | "capability">;
  env: NodeJS.ProcessEnv;
  /** Rehash the authenticated target closure and pinned runtime before executing it. */
  verifyTarget: () => Promise<void>;
}) {
  const { input, fence, recipe } = options;
  if (
    recipe.maintenance.binding.runId !== input.binding.runId ||
    recipe.maintenance.binding.installationKey !== input.binding.installationKey
  ) {
    throw new Error("Recipe maintenance changed its original context binding.");
  }
  const env = cloneEnvWithPlatformSemantics(options.env);
  // Byte admission cannot validate interpreter preloads or dynamic-loader code.
  // Refuse this unsupported environment rather than silently changing its policy.
  const loaderSelectors = new Set([
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_AUDIT",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
    "DYLD_FALLBACK_LIBRARY_PATH",
    "DYLD_FALLBACK_FRAMEWORK_PATH",
    "OPENSSL_CONF",
  ]);
  if (Object.entries(env).some(([key, value]) => value && loaderSelectors.has(key.toUpperCase()))) {
    throw new Error(
      "Recipe target launch requires an environment without interpreter or native-loader injection.",
    );
  }
  const authority = captureUpdateCommandExecutorAuthority(fence, input.binding.runId);
  if (
    authority.installKey !== input.binding.installationKey ||
    input.expected.installationRoot !== input.binding.installationKey
  ) {
    throw new Error("Recipe maintenance cannot redirect its original installation owner.");
  }
  await options.verifyTarget();
  fence.assertCurrent();
  const argv: [string, string] = [
    input.expected.runtimeExecutable,
    path.join(
      input.expected.installationRoot,
      "dist",
      runtimeProcessEntrypoints.updateRecipeMaintenance.distWorkerPath,
    ),
  ];
  const invoke = (mode: "--check" | "--run", inspector?: string) =>
    withUpdateCommandExecutorChild(
      fence,
      input.binding.installationKey,
      async (executor, bindChild) => {
        const payload =
          mode === "--check"
            ? ""
            : JSON.stringify({
                ...input,
                capability: UPDATE_RECIPE_MAINTENANCE_CAPABILITY,
                executor,
              });
        if (Buffer.byteLength(payload) > 1024 * 1024) {
          throw new Error("Approved maintenance facts exceed the private transport bound.");
        }
        const command = await runCommandWithTimeout(
          inspector ? [argv[0], inspector, argv[1], mode] : [...argv, mode],
          {
            ...(inspector
              ? {
                  onOutputChunk: (chunk: Buffer, stream: string) => {
                    if (stream === "stderr") {
                      process.stderr.write(chunk);
                    }
                  },
                }
              : {}),
            baseEnv: {},
            env,
            cwd: input.binding.installationKey,
            input: payload,
            beforeInput: bindChild,
            timeoutMs: input.timeoutMs,
            maxOutputBytes: { stdout: mode === "--check" ? 1024 : 65536, stderr: 65536 },
            killProcessTree: true,
            requireProcessTreeExtinction: true,
          },
        );
        if (command.cleanup === "forced" || command.cleanup === "uncertain") {
          throw new CommandProcessCleanupError();
        }
        return command;
      },
    );
  const check = await invoke("--check");
  fence.assertCurrent();
  const expectedCapability = JSON.stringify({ capability: UPDATE_RECIPE_MAINTENANCE_CAPABILITY });
  if (
    check.code !== 0 ||
    check.termination !== "exit" ||
    check.signal !== null ||
    check.killed ||
    check.stdoutTruncatedBytes ||
    check.outputLimitExceeded ||
    check.outputErrorStream ||
    check.stdout.trim() !== expectedCapability
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Target does not advertise the required maintenance capability.",
    );
  }
  await options.verifyTarget();
  fence.assertCurrent();
  const inspector = await admitReleaseQualificationChildInspector(recipe, fence);
  const result = await invoke("--run", inspector);
  fence.assertCurrent();
  if (
    result.stdoutTruncatedBytes ||
    result.outputLimitExceeded ||
    result.outputErrorStream ||
    result.termination !== "exit" ||
    result.signal !== null ||
    result.killed
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Target maintenance did not return complete settled evidence; retain original recovery.",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    throw new UpdateCommandRecoveryPendingError(
      "Target maintenance completion is unknown; reconcile the original run without replay.",
    );
  }
  const uncertain = z.object({ processSettlement: z.literal("uncertain") }).safeParse(raw);
  if (uncertain.success) {
    throw new CommandProcessCleanupError();
  }
  const parsed = resultSchema.safeParse(raw);
  if (
    result.code !== 0 ||
    !parsed.success ||
    parsed.data.receipt.phase !== "committed" ||
    JSON.stringify(parsed.data.receipt.binding) !== JSON.stringify(input.binding)
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Target maintenance did not verify the exact approved run; preserve current state.",
    );
  }
  // The existing finalizer still owns actual managed-service startup and readiness.
  return parsed.data;
}
