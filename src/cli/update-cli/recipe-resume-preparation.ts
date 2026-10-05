import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createConfigIO } from "../../config/io.factory.js";
import { isGatewayServiceStateLive } from "../../daemon/service-runtime.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-swap-contract.js";
import { validateUpdateCandidateCanary } from "../../infra/update-candidate-canary.js";
import {
  readUpdateStateSchemaVersions,
  resolveUpdateStateContentVersion,
} from "../../infra/update-candidate-state.js";
import { createUpdateDatabaseBackup } from "../../infra/update-database-backup.js";
import { createGlobalInstallEnv } from "../../infra/update-global.js";
import { readUpdateRecoveryBaselineIdentity } from "../../infra/update-recovery-backup-reader.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { assertUpgradeRecipeCapacityInputs } from "../../infra/upgrade-recipes/execution-capacity.js";
import { createUpgradeRecipeMaintenanceOwner } from "../../infra/upgrade-recipes/maintenance.js";
import { createFencedUpgradeRecipeStepReceiptRecorder } from "../../infra/upgrade-recipes/receipts-worker.js";
import type { RetainedUpgradeRecipeRun } from "../../infra/upgrade-recipes/recovery.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { resolveRecipeStepBinding } from "./recipe-step-execution.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import { createPackageUpdateActivationOptions } from "./update-command-package-activation.js";
import { runPackageInstallUpdate } from "./update-command-package.js";
import { UpdateCommandRecipeReconciliationPendingError } from "./update-command-recovery-error.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";
import {
  readGatewayServiceStateForUpdate,
  inspectManagedGatewayServiceBeforeUpdate,
} from "./update-command-service-plan.js";
import {
  assertRecipeUpdateEnvironment,
  assertRecipeUpdatePackageOwner,
  resolveRecipeUpdatePackageTarget,
  verifyRecipeUpdateArchive,
  verifyRecipeUpdateConfig,
  verifyRecipeUpdateInstallation,
  type RecipeUpdateContext,
} from "./update-recipe-context.js";

type Input = {
  recipe: RecipeUpdateContext;
  retained: RetainedUpgradeRecipeRun;
  fence: UpdateRecoveryFence;
  env: NodeJS.ProcessEnv;
};
const normalized = (entries: RecipeUpdateContext["sourceStateVersions"]) =>
  entries
    .map((entry) => ({ path: entry.path, version: resolveUpdateStateContentVersion(entry) }))
    .toSorted((left, right) => left.path.localeCompare(right.path));

/** Reobserve the approved before image; an existing intent is not replay authorization. */
export async function prepareOriginalRecipePublication(input: Input & { candidateRoot: string }) {
  const { recipe, retained, env, fence } = input;
  const assertCurrent = () => fence.assertCurrent();
  const root = retained.binding.installationKey;
  assertRecipeUpdateEnvironment(recipe, env);
  const original = retained.originalRecoveryCapture;
  if (!original) {
    throw new Error("Original source preparation lost its retained pre-update capture.");
  }
  await readUpdateRecoveryBaselineIdentity({
    runId: retained.binding.runId,
    env,
    ref: original,
    installRoot: root,
    readContinuation: () => getUpdateRun(retained.binding.runId, { env }),
    assertCurrent,
  });
  await verifyRecipeUpdateInstallation(recipe, root, "source");
  await verifyRecipeUpdateInstallation(recipe, input.candidateRoot, "target");
  await verifyRecipeUpdateArchive(recipe);
  await verifyRecipeUpdateConfig(recipe, env);
  assertCurrent();
  const snapshot = await createConfigIO({
    configPath: recipe.maintenance.expected.configPath,
    env,
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshot();
  assertCurrent();
  const versions = await readUpdateStateSchemaVersions({
    root,
    nodeRunner: recipe.maintenance.expected.runtimeExecutable,
    stateDir: recipe.maintenance.expected.stateRoot,
    config: snapshot.config,
    env,
    timeoutMs: recipe.maintenance.timeoutMs,
  });
  assertCurrent();
  if (!isDeepStrictEqual(normalized(versions), normalized(recipe.sourceStateVersions))) {
    throw new Error("Original preparation state differs from its approved source contracts.");
  }
  const target = await resolveRecipeUpdatePackageTarget(
    recipe.packageOwner,
    root,
    recipe.maintenance.timeoutMs,
    env,
  );
  assertCurrent();
  assertRecipeUpdatePackageOwner(recipe, target);
  await assertUpgradeRecipeCapacityInputs(recipe.planningEvidence.executionCapacity, {
    installationRoot: root,
    candidateRoot: input.candidateRoot,
    runnerRoot: recipe.runner.root,
    archivePath: recipe.localArchivePath,
    stateRoot: recipe.maintenance.expected.stateRoot,
  });
  assertCurrent();
  const state = await readGatewayServiceStateForUpdate(
    resolveGatewayService(),
    env,
    recipe.maintenance.timeoutMs,
    { managerUid: recipe.service.managerUid, assertCurrent },
  );
  assertRecipeUpdateEnvironment(recipe, state.env);
  const verdict = await inspectManagedGatewayServiceBeforeUpdate({ state, root });
  assertCurrent();
  const native = state.runtime?.systemd;
  if (
    verdict.kind !== "owned" ||
    verdict.fingerprint !== recipe.service.beforeDefinitionFingerprint ||
    native?.scope !== recipe.service.scope ||
    native.unit !== recipe.service.unitName ||
    native.managerUid !== recipe.service.managerUid
  ) {
    throw new Error("Original preparation service ownership or approved definition changed.");
  }
  const owner = {
    env,
    context: captureOpenClawStateWorkerContext({ env }),
    assertCurrent,
    assertEffectsSettled: assertCurrent,
  };
  const maintenance = createUpgradeRecipeMaintenanceOwner(retained.binding, owner);
  const receipt = await maintenance.read();
  assertCurrent();
  if (
    receipt &&
    (!isDeepStrictEqual(receipt.binding, retained.binding) ||
      receipt.phase !== "maintenance-required")
  ) {
    throw new Error("Original preparation cannot cross or replace another maintenance admission.");
  }
  const binding = await resolveRecipeStepBinding(recipe, "core.package-publish");
  const steps = createFencedUpgradeRecipeStepReceiptRecorder(binding, owner);
  const intent = await steps.read();
  assertCurrent();
  if (intent?.phase === "verified") {
    throw new Error("Original preparation cannot replay its verified package step.");
  }
  if (!receipt) {
    await maintenance.requireMaintenance(null);
    assertCurrent();
  }
  if (isGatewayServiceStateLive(state)) {
    // This is the authenticated, unchanged source before native publication,
    // not a running target whose historical activation could be replayed.
    const run = { runId: retained.binding.runId, env, executorFence: fence };
    const guards = createUpdateCommandExecutionGuards({ run, recipe }, root);
    await maybeStopManagedServiceBeforeMutableUpdate({
      updateRun: { runId: retained.binding.runId, env, executorFence: fence },
      recordPhase: guards.recordPhase,
      updateInstallKind: "package",
      root,
      shouldRestart: true,
      jsonMode: true,
      timeoutMs: recipe.maintenance.timeoutMs,
      expectedService: {
        serviceEnv: state.env,
        serviceUpdateVerdict: verdict,
        serviceManagerUid: recipe.service.managerUid,
      },
      assertCurrent,
    });
    assertCurrent();
  }
  const stopped = await readGatewayServiceStateForUpdate(
    resolveGatewayService(),
    env,
    recipe.maintenance.timeoutMs,
    { managerUid: recipe.service.managerUid, assertCurrent },
  );
  assertRecipeUpdateEnvironment(recipe, stopped.env);
  assertCurrent();
  if (stopped.runtime?.status !== "stopped" || isGatewayServiceStateLive(stopped)) {
    throw new Error("Original publication requires the exact owned service to be stopped.");
  }
  await steps.prepareIntent();
  assertCurrent();
  // A fresh stopped-state snapshot uses the existing snapshot and physical state
  // owner. It never adopts an orphan snapshot or restores historical contents.
  const lock = await acquireGatewayLock({ env, role: "sqlite-maintenance", timeoutMs: 0 });
  if (!lock) {
    throw new Error("Original publication cannot acquire exclusive source snapshot ownership.");
  }
  const snapshotDemand = recipe.planningEvidence.executionCapacity.demands.find(
    (entry) => entry.purpose === "state-snapshot-scratch",
  );
  if (!snapshotDemand) {
    await lock.release();
    throw new Error("Original preparation lost its approved snapshot filesystem.");
  }
  try {
    await lock.run(() =>
      createUpdateDatabaseBackup({
        backupRoot: path.join(
          snapshotDemand.directory,
          `resume-${retained.binding.runId}-${randomUUID()}`,
        ),
        stateDir: recipe.maintenance.expected.stateRoot,
        config: snapshot.config,
        env,
        nodeRunner: recipe.maintenance.expected.runtimeExecutable,
        timeoutMs: recipe.maintenance.timeoutMs,
        preserveSourceArtifacts: true,
      }),
    );
    assertCurrent();
    lock.assertCurrent();
  } finally {
    await lock.release();
  }
  await verifyRecipeUpdateConfig(recipe, env);
  assertCurrent();
}

/** No journal means retention preceded staging. Reuse the same package engine and original native lineage. */
export async function resumeOriginalRecipeStaging(input: Input): Promise<void> {
  const { recipe, retained, env, fence } = input;
  const root = retained.binding.installationKey;
  const assertCurrent = () => fence.assertCurrent();
  await verifyRecipeUpdateInstallation(recipe, root, "source");
  await verifyRecipeUpdateArchive(recipe);
  await verifyRecipeUpdateConfig(recipe, env);
  assertCurrent();
  const target = await resolveRecipeUpdatePackageTarget(
    recipe.packageOwner,
    root,
    recipe.maintenance.timeoutMs,
    env,
  );
  assertRecipeUpdatePackageOwner(recipe, target);
  assertCurrent();
  let candidateRoot: string | undefined;
  let transaction: PackageUpdateTransaction | undefined;
  const guards = createUpdateCommandExecutionGuards(
    {
      recipe,
      run: { runId: retained.binding.runId, env, executorFence: fence },
    },
    root,
  );
  const result = await runPackageInstallUpdate({
    root,
    installKind: "package",
    tag: recipe.maintenance.expected.version,
    installSpec: recipe.localArchivePath,
    installTarget: target,
    installEnv: await createGlobalInstallEnv(env),
    honorPackageRoot: true,
    requirePackageReplacement: true,
    timeoutMs: recipe.maintenance.timeoutMs,
    startedAt: Date.now(),
    progress: {},
    nodeRunner: recipe.maintenance.expected.runtimeExecutable,
    managedServiceEnv: env,
    invocationCwd: recipe.artifactsDirectory,
    assertCurrent,
    ...createPackageUpdateActivationOptions({
      run: { runId: retained.binding.runId, env, executorFence: fence },
      assertCurrent,
    }),
    beforeVerifyCandidate: async (candidate) => {
      await verifyRecipeUpdateInstallation(recipe, candidate, "target");
      assertCurrent();
    },
    validateCandidate: async (candidate) => {
      candidateRoot = candidate;
      const snapshot = await createConfigIO({
        configPath: recipe.maintenance.expected.configPath,
        env,
        observe: false,
        pluginValidation: "core-only",
      }).readConfigFileSnapshot();
      assertCurrent();
      const canary = await validateUpdateCandidateCanary({
        root: candidate,
        env,
        config: snapshot.config,
        stateDir: recipe.maintenance.expected.stateRoot,
        nodeRunner: recipe.maintenance.expected.runtimeExecutable,
        timeoutMs: recipe.maintenance.timeoutMs,
        assertCurrent,
        observeStateVersions: true,
      });
      assertCurrent();
      if (
        canary.status !== "ok" ||
        !canary.stateObservation ||
        canary.doctorConfigWrites === true ||
        !isDeepStrictEqual(
          normalized(canary.stateObservation.sourceStateVersions),
          normalized(recipe.sourceStateVersions),
        ) ||
        !isDeepStrictEqual(
          normalized(canary.stateObservation.stateVersions),
          normalized(recipe.maintenance.stateVersions),
        )
      ) {
        throw new Error(
          "Original staging rehearsal differs from the approved exact state/config contract.",
        );
      }
      return canary.steps;
    },
    beforeActivate: async () => {
      if (!candidateRoot) {
        throw new Error("Original staging lost its authenticated candidate.");
      }
      await prepareOriginalRecipePublication({ ...input, candidateRoot });
    },
    onTransaction: async (selected) => {
      transaction = selected;
    },
    // The same installed Doctor process owner receives the retained original
    // capture. No unbound installed CLI or fresh update admission is invoked.
    getDoctorContext: () => ({
      runId: retained.binding.runId,
      executorFence: fence,
      inputHash: recipe.maintenance.expected.configHash,
      changes: [],
      originalRecoveryCapture: retained.originalRecoveryCapture,
      assertCurrent,
      assertBoundChildCurrent: guards.assertBoundChildCurrent,
    }),
  });
  assertCurrent();
  if (!transaction || result.status !== "ok") {
    throw new UpdateCommandRecipeReconciliationPendingError(
      "Original package preparation did not complete; preserve its native journal and snapshots.",
    );
  }
}
