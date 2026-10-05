import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createConfigIO } from "../../config/io.factory.js";
import { resolveStateDir } from "../../config/paths.js";
import { isGatewayServiceStateLive } from "../../daemon/service-runtime.js";
import { reconcileOriginalRunPackagePublication } from "../../infra/package-update-activation-original-run.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  readUpdateStateSchemaVersions,
  updateStateSchemaVersionsMatch,
} from "../../infra/update-candidate-state.js";
import { UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV } from "../../infra/update-doctor-result.js";
import { readUpdateRecoveryBaselineIdentity } from "../../infra/update-recovery-backup-reader.js";
import { finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { readUpgradeRecipeMaintenanceReceipt } from "../../infra/upgrade-recipes/maintenance.js";
import { createFencedUpgradeRecipeStepReceiptRecorder } from "../../infra/upgrade-recipes/receipts-worker.js";
import { resumeUpgradeRecipeOriginalRun } from "../../infra/upgrade-recipes/recovery.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { runUpgradeRecipeTargetMaintenance } from "./recipe-maintenance-target.js";
import { inspectOriginalRecipePackagePublication } from "./recipe-original-publication.js";
import { createRecipeOriginalRecoveryPorts } from "./recipe-recovery-ports.js";
import {
  recipeResumeInputSchema,
  recipeResumeResultSchema,
  UPDATE_RECIPE_RESUME_CAPABILITY,
  type RecipeResumeResult,
} from "./recipe-resume-contract.js";
import {
  observeRecipeServiceForRecovery,
  prepareRecipeServiceActivation,
  reconcileRecipePackagePublication,
  reconcileRecipeServiceActivation,
  reconcileRecipeTargetMaintenance,
  resolveRecipeStepBinding,
} from "./recipe-step-execution.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  withUpdateDoctorChild,
  assertUpdateDoctorChildSucceeded,
} from "./update-command-doctor-child.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import { withDelegatedUpdateCommandExecutor } from "./update-command-executor.js";
import { UpdateCommandRecipeReconciliationPendingError } from "./update-command-recovery-error.js";
import { runUpdatedInstallGatewayCommand } from "./update-command-service-command.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";
import {
  verifyRecipeUpdateConfig,
  verifyRecipeUpdateInstallation,
} from "./update-recipe-context.js";
import type { RecipeUpdateContext } from "./update-recipe-context.js";

type ReceiptOwner = Parameters<typeof reconcileRecipeServiceActivation>[1];

/** Fresh observations decide activation; an intent never authorizes restarting a running service. */
export async function resumeRecipeTargetService(options: {
  recipe: RecipeUpdateContext;
  owner: ReceiptOwner;
  opts: UpdateCommandOptions;
  result: UpdateRunResult;
}) {
  const { recipe, owner, opts, result } = options;
  const binding = await resolveRecipeStepBinding(recipe, "core.service-verify");
  owner.assertCurrent();
  const recorder = createFencedUpgradeRecipeStepReceiptRecorder(binding, owner);
  const intent = await recorder.read();
  const { state } = await observeRecipeServiceForRecovery(recipe, owner);
  owner.assertCurrent();
  if (state.runtime?.status === "running" && isGatewayServiceStateLive(state)) {
    if (!intent) {
      throw new UpdateCommandRecipeReconciliationPendingError(
        "Running target has no original activation intent; preserve it without adopting or restarting.",
      );
    }
  } else if (state.runtime?.status === "stopped" && !isGatewayServiceStateLive(state)) {
    if (intent?.phase === "verified") {
      throw new UpdateCommandRecipeReconciliationPendingError(
        "Previously verified service is now stopped; do not replay its historical activation.",
      );
    }
    if (!intent) {
      await prepareRecipeServiceActivation(recipe, owner);
    }
    owner.assertCurrent();
    const accepted = await runUpdatedInstallGatewayCommand(
      {
        result,
        opts,
        invocationEnv: owner.env,
        serviceEnv: state.env,
        nodeRunner: recipe.maintenance.expected.runtimeExecutable,
        gatewayPort: recipe.maintenance.port,
        timeoutMs: recipe.maintenance.timeoutMs,
        assertCurrent: owner.assertCurrent,
      },
      "restart",
    );
    owner.assertCurrent();
    if (accepted !== "accepted") {
      throw new UpdateCommandRecipeReconciliationPendingError(
        "Owned stopped service activation is unresolved; preserve original recovery.",
      );
    }
  } else {
    throw new UpdateCommandRecipeReconciliationPendingError(
      "Native service state is unknown; do not replay activation.",
    );
  }
  let freshlyVerified = false;
  const verification = await verifyUpdatedGateway({
    result,
    opts,
    serviceEnv: state.env,
    gatewayPort: recipe.maintenance.port,
    timeoutMs: recipe.maintenance.timeoutMs,
    expectedVersion: recipe.maintenance.expected.version,
    expectedBuildId: recipe.maintenance.expected.buildId,
    requireRunningService: true,
    requirePluginHealth: false,
    assertCurrent: owner.assertCurrent,
    onVerified: () => {
      freshlyVerified = true;
    },
  });
  owner.assertCurrent();
  if (!verification.ok || !freshlyVerified) {
    throw new UpdateCommandRecipeReconciliationPendingError(
      "Current target readiness is unverified; retain original package and run.",
    );
  }
  await reconcileRecipeServiceActivation(recipe, owner, freshlyVerified);
  owner.assertCurrent();
}

async function resumeTargetUnderFence(options: {
  recovery: Awaited<ReturnType<typeof createRecipeOriginalRecoveryPorts>>;
  fence: UpdateRecoveryFence;
}): Promise<RecipeResumeResult> {
  const { recovery, fence } = options;
  recovery.bindNativeFence(fence);
  const { recipe, env, retained } = recovery;
  return await resumeUpgradeRecipeOriginalRun({
    runId: retained.binding.runId,
    ports: recovery.ports,
    admittedFence: fence,
    continueRun: async () => {
      const runId = retained.binding.runId;
      const opts: UpdateCommandOptions = {
        json: true,
        recipe,
        run: { runId, env, executorFence: fence },
      };
      const guards = createUpdateCommandExecutionGuards(opts, retained.binding.installationKey);
      guards.onStateHandoff();
      const captured = guards.captureWriteOptions();
      const assertCurrent = () => {
        captured.assertCurrent();
        fence.assertCurrent();
        if (getUpdateRun(runId, { env })?.status !== "running") {
          throw new Error("Recipe target no longer owns its original running ledger.");
        }
      };
      const owner = { ...captured, env, assertCurrent, assertEffectsSettled: assertCurrent };
      const verifyTarget = async () => {
        await verifyRecipeUpdateInstallation(recipe, retained.binding.installationKey, "target");
        await verifyRecipeUpdateConfig(recipe, env);
        assertCurrent();
      };
      await verifyTarget();
      const publication = await inspectOriginalRecipePackagePublication({
        retained,
        recipe,
        assertCurrent,
      });
      const native = await reconcileOriginalRunPackagePublication({
        fence,
        retained,
        operationId: publication.operationId,
        expectedCandidate: publication.expectedCandidate,
      });
      assertCurrent();
      const config = await createConfigIO({
        configPath: recipe.maintenance.expected.configPath,
        env,
        observe: false,
        pluginValidation: "core-only",
      }).readConfigFileSnapshot();
      assertCurrent();
      const currentVersions = await readUpdateStateSchemaVersions({
        root: retained.binding.installationKey,
        nodeRunner: recipe.maintenance.expected.runtimeExecutable,
        stateDir: resolveStateDir(env),
        config: config.config,
        env,
        timeoutMs: recipe.maintenance.timeoutMs,
      });
      assertCurrent();
      if (
        !updateStateSchemaVersionsMatch(recipe.maintenance.stateVersions, currentVersions, {
          sharedPath: resolveOpenClawStateSqlitePath(env),
        })
      ) {
        const receipt = await readUpgradeRecipeMaintenanceReceipt({ env });
        assertCurrent();
        if (
          !receipt ||
          receipt.phase !== "maintenance-required" ||
          !isDeepStrictEqual(receipt.binding, retained.binding)
        ) {
          throw new Error("State repair cannot replay after maintenance commit admission.");
        }
        const service = await observeRecipeServiceForRecovery(recipe, owner);
        if (
          isGatewayServiceStateLive(service.state) ||
          service.state.runtime?.status !== "stopped"
        ) {
          throw new Error(
            "Original Doctor continuation requires the owned service to remain stopped.",
          );
        }
        const originalRecoveryCapture = retained.originalRecoveryCapture;
        if (!originalRecoveryCapture) {
          throw new Error(
            "Original Doctor continuation has lost its admitted pre-update snapshot.",
          );
        }
        await readUpdateRecoveryBaselineIdentity({
          runId,
          env,
          ref: originalRecoveryCapture,
          installRoot: retained.binding.installationKey,
          readContinuation: () => getUpdateRun(runId, { env }),
          assertCurrent,
        });
        assertCurrent();
        await verifyTarget();
        const doctorResultPath = path.join(
          recipe.artifactsDirectory,
          `resume-doctor-${runId}-${process.pid}.json`,
        );
        const child = await withUpdateDoctorChild(
          {
            root: retained.binding.installationKey,
            context: { runId, executorFence: fence, assertRequesterCurrent: assertCurrent },
            input: {
              configInputHash: recipe.maintenance.expected.configHash,
              originalRecoveryCapture,
              repair: true,
              yes: true,
              workspaceSuggestions: false,
            },
          },
          (runCommand) =>
            runCommand(
              [
                recipe.maintenance.expected.runtimeExecutable,
                path.join(
                  retained.binding.installationKey,
                  "dist",
                  runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
                ),
                "--doctor",
              ],
              {
                baseEnv: {},
                env: { ...env, [UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]: doctorResultPath },
                cwd: retained.binding.installationKey,
                timeoutMs: recipe.maintenance.timeoutMs,
                killProcessTree: true,
                requireProcessTreeExtinction: true,
                maxOutputBytes: 65536,
              },
            ),
        );
        assertUpdateDoctorChildSucceeded(child);
        assertCurrent();
        await verifyTarget();
      }
      await reconcileRecipePackagePublication(recipe, owner);
      const maintenance = await readUpgradeRecipeMaintenanceReceipt({ env });
      assertCurrent();
      if (!maintenance || !isDeepStrictEqual(maintenance.binding, retained.binding)) {
        throw new Error("Original target has lost its exact maintenance exclusion.");
      }
      if (maintenance.phase !== "committed") {
        const state = await observeRecipeServiceForRecovery(recipe, owner);
        if (isGatewayServiceStateLive(state.state) || state.state.runtime?.status !== "stopped") {
          throw new Error("Uncommitted maintenance requires the owned service to remain stopped.");
        }
        const binding = await resolveRecipeStepBinding(recipe, "core.gateway-maintenance");
        assertCurrent();
        // A retained intent is reconciled by the same maintenance owner, not fresh prepare hooks.
        await createFencedUpgradeRecipeStepReceiptRecorder(binding, owner).prepareIntent();
        await runUpgradeRecipeTargetMaintenance({
          recipe,
          fence,
          input: recipe.maintenance,
          env,
          verifyTarget,
        });
        assertCurrent();
      }
      await reconcileRecipeTargetMaintenance(recipe, owner);
      const result: UpdateRunResult = {
        runId,
        status: "ok",
        mode: "npm",
        root: retained.binding.installationKey,
        after: {
          version: recipe.maintenance.expected.version,
          buildId: recipe.maintenance.expected.buildId,
        },
        steps: [],
        durationMs: 0,
      };
      await resumeRecipeTargetService({ recipe, owner, opts, result });
      assertCurrent();
      const verified = getUpdateRun(runId, { env })?.verification;
      result.verification = verified;
      // Retirement is idempotently resumed by the existing journal owner. A crash
      // here retains the original running ledger for another fresh target proof.
      await native.transaction.complete({ activationVerified: true }, assertCurrent);
      assertCurrent();
      const terminal = finishUpdateRun(
        runId,
        {
          status: "succeeded",
          after: result.after,
          diagnostics: { verification: verified, steps: result.steps },
        },
        { env },
      );
      fence.assertCurrent();
      if (terminal.status !== "succeeded" || terminal.runId !== runId) {
        throw new Error("Original recipe terminal publication was not acknowledged.");
      }
      return recipeResumeResultSchema.parse({
        capability: UPDATE_RECIPE_RESUME_CAPABILITY,
        runId,
        terminalRunId: runId,
        outcome: "completed",
        managedServiceVerified: true,
        result,
      });
    },
  });
}

/** Installed target receiver, under independently PID/start-bound native child custody. */
export async function runRecipeResumeTarget(raw: unknown, entryUrl: string): Promise<void> {
  const input = recipeResumeInputSchema.parse(raw);
  if (input.executor.runId !== input.runId || !path.isAbsolute(input.resultPath)) {
    throw new Error("Recipe resume transport differs from its original child binding.");
  }
  const recovery = await createRecipeOriginalRecoveryPorts({
    runId: input.runId,
    ledgerPath: input.ledgerPath,
    runnerEntryUrl: entryUrl,
    targetReceiver: true,
  });
  if (input.executor.root !== recovery.retained.binding.installationKey) {
    throw new Error("Recipe target grant selects another installation.");
  }
  const response = await withDelegatedUpdateCommandExecutor(
    input.executor,
    input.runId,
    recovery.retained.binding.installationKey,
    (fence) => resumeTargetUnderFence({ recovery, fence }),
    { activationTimeoutMs: recovery.recipe.maintenance.timeoutMs },
  );
  // Publish only after all delegated command descendants and accepted writes settle.
  const file = await fs.open(input.resultPath, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(response));
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Fresh recipe finalization transfers native retirement into the target schema owner. */
export async function recoverRecipeTargetTransaction(options: {
  runId: string;
  ledgerPath: string;
  entryUrl: string;
  fence: UpdateRecoveryFence;
}) {
  const recovery = await createRecipeOriginalRecoveryPorts({
    runId: options.runId,
    ledgerPath: options.ledgerPath,
    runnerEntryUrl: options.entryUrl,
    targetReceiver: true,
  });
  recovery.bindNativeFence(options.fence);
  return await resumeUpgradeRecipeOriginalRun({
    runId: options.runId,
    ports: recovery.ports,
    admittedFence: options.fence,
    continueRun: async ({ retained, fence }) => {
      const publication = await inspectOriginalRecipePackagePublication({
        retained,
        recipe: recovery.recipe,
        assertCurrent: () => fence.assertCurrent(),
      });
      fence.assertCurrent();
      const native = await reconcileOriginalRunPackagePublication({
        fence,
        retained,
        operationId: publication.operationId,
        expectedCandidate: publication.expectedCandidate,
      });
      fence.assertCurrent();
      return { recipe: recovery.recipe, transaction: native.transaction };
    },
  });
}
