import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { stableConfigStringify } from "../../config/runtime-config-snapshot-match.js";
import { hasErrnoCode } from "../../infra/errno.js";
import {
  assertPackageActivationLayout,
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
} from "../../infra/package-update-activation-journal.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { runSqliteReadOnlyOperation } from "../../infra/sqlite-readonly-worker.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { recoverOriginalUpgradeRecipeCatalog } from "../../infra/upgrade-recipes/catalog.js";
import { readUpgradeRecipeMaintenanceReceipt } from "../../infra/upgrade-recipes/maintenance.js";
import type { RetainedUpgradeRecipeRun } from "../../infra/upgrade-recipes/recovery.js";
import { createRetainedUpgradeRecipeRunStore } from "../../infra/upgrade-recipes/retained-run.js";
import { verifyUpgradeRecipeRunnerBundle } from "../../infra/upgrade-recipes/runner-bundle.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { bindReleaseQualificationTargetReceiver } from "./recipe-first-qualification.js";
import { inspectOriginalRecipePackagePublication } from "./recipe-original-publication.js";
import {
  assertRecipeUpdateBinding,
  bindRecoveredRecipeUpdateCatalog,
  recipeUpdateContextSchema,
  resolveAuthenticatedRecipeUpdateCatalog,
  verifyRecipeUpdateConfig,
  verifyRecipeUpdateInstallation,
} from "./update-recipe-context.js";

const retainedConfigSchema = z.strictObject({
  path: z.string(),
  hash: z.string(),
  sourceConfig: z.json(),
});

/** Concrete original ledger/artifact/trust ports. Selecting a file alone never grants native custody. */
export async function createRecipeOriginalRecoveryPorts(options: {
  runId: string;
  ledgerPath: string;
  runnerEntryUrl: string;
  /** Target receiver still requires an independently bound native child grant. */
  targetReceiver?: true;
}) {
  const runId = z.uuid().parse(options.runId);
  const ledgerPath = path.resolve(options.ledgerPath);
  if ((await fs.realpath(ledgerPath)) !== ledgerPath) {
    throw new Error("Recipe resume requires its canonical original operational ledger.");
  }
  const context = captureOpenClawStateWorkerContext({ path: ledgerPath });
  let liveFence: UpdateRecoveryFence | undefined;
  const assertCurrent = () => {
    context.admission.assertCurrent();
    liveFence?.assertCurrent();
  };
  const store = createRetainedUpgradeRecipeRunStore({ path: ledgerPath, context, assertCurrent });
  const envelope = await store.readRetainedEnvelope(runId);
  const { retainedUpgradeRecipeRunSchema } =
    await import("../../infra/upgrade-recipes/recovery.js");
  const retained = retainedUpgradeRecipeRunSchema.parse(JSON.parse(envelope.toString("utf8")));
  if (retained.binding.runId !== runId || retained.ledgerAuthority.databasePath !== ledgerPath) {
    throw new Error("Recipe recovery pointer selects another original run or operational ledger.");
  }
  const recipe = recipeUpdateContextSchema.parse(
    JSON.parse((await store.readArtifact(retained.planArtifact)).toString("utf8")),
  );
  assertRecipeUpdateBinding(recipe, retained.binding.installationKey, runId);
  if (!isDeepStrictEqual(recipe.maintenance.binding, retained.binding)) {
    throw new Error("Recipe recovery plan differs from its original retained maintenance owner.");
  }
  const expected = recipe.maintenance.expected;
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: expected.stateRoot,
    OPENCLAW_CONFIG_PATH: expected.configPath,
    OPENCLAW_PROFILE: expected.profile,
  };
  if (resolveOpenClawStateSqlitePath(env) !== ledgerPath) {
    throw new Error("Recipe recovery environment selects a different operational ledger.");
  }
  const requireRetained = (selected: RetainedUpgradeRecipeRun) => {
    assertCurrent();
    if (!isDeepStrictEqual(selected, retained)) {
      throw new Error("Recipe recovery changed its original retained evidence.");
    }
  };
  const hasPublication = async () => {
    assertCurrent();
    const anchor = resolvePackageActivationAnchor(retained.binding.installationKey);
    assertPackageActivationLayout(anchor);
    const exists = async (filename: string) => {
      try {
        await fs.lstat(filename);
        return true;
      } catch (error) {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
        return false;
      }
    };
    const present =
      (await exists(anchor)) || (await exists(resolvePackageActivationControl(anchor)));
    assertCurrent();
    return present;
  };
  const ports = store.recoveryPorts({
    verifyRetainedAuthorization: async (selected, bytes) => {
      requireRetained(selected);
      const catalog = await recoverOriginalUpgradeRecipeCatalog(selected, bytes, {
        path: ledgerPath,
        context,
        env,
        assertCurrent,
        catalog: recipe.catalog,
      });
      assertCurrent();
      bindRecoveredRecipeUpdateCatalog(recipe, catalog);
    },
    verifyRetainedPlanAndConfig: async (selected, planBytes, configBytes) => {
      requireRetained(selected);
      const actual = recipeUpdateContextSchema.parse(
        JSON.parse(Buffer.from(planBytes).toString("utf8")),
      );
      if (!isDeepStrictEqual(actual, recipe)) {
        throw new Error("Recipe recovery plan bytes changed after original selection.");
      }
      assertRecipeUpdateBinding(actual, retained.binding.installationKey, runId);
      const config = retainedConfigSchema.parse(
        JSON.parse(Buffer.from(configBytes).toString("utf8")),
      );
      if (
        config.path !== expected.configPath ||
        config.hash !== expected.configHash ||
        createHash("sha256").update(stableConfigStringify(config.sourceConfig)).digest("hex") !==
          expected.configSourceDigest
      ) {
        throw new Error("Recipe recovery configuration differs from original explicit consent.");
      }
      await verifyRecipeUpdateConfig(recipe, env);
      assertCurrent();
    },
    verifyRetainedRunner: async (selected) => {
      requireRetained(selected);
      const catalog = await resolveAuthenticatedRecipeUpdateCatalog(recipe);
      const runner = await verifyUpgradeRecipeRunnerBundle({
        catalog,
        bundleRoot: recipe.runner.root,
        manifestArtifactId: recipe.runner.manifestArtifactId,
        forbiddenRoots: recipe.catalog.forbiddenRoots,
      });
      assertCurrent();
      const actualEntry = await fs.realpath(fileURLToPath(options.runnerEntryUrl));
      const retainedEntry = recipe.releaseQualification
        ? runner.releaseQualificationEntrypointPath
        : runner.entrypointPath;
      if (!retainedEntry) {
        throw new Error(
          "Recipe resume has lost its authenticated retained qualification entrypoint.",
        );
      }
      const entry = options.targetReceiver
        ? path.join(
            expected.installationRoot,
            "dist",
            runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
          )
        : retainedEntry;
      if ((await fs.realpath(process.execPath)) !== runner.runtimePath || actualEntry !== entry) {
        throw new Error(
          "Recipe resume must run from its authenticated retained runtime and entrypoint.",
        );
      }
      if (options.targetReceiver) {
        await verifyRecipeUpdateInstallation(recipe, expected.installationRoot, "target");
      }
      assertCurrent();
      return { ...runner, entrypointPath: retainedEntry };
    },
    assertOriginalRecoveryOwner: async (selected) => {
      requireRetained(selected);
      if (await hasPublication()) {
        await inspectOriginalRecipePackagePublication({
          retained: selected,
          recipe,
          assertCurrent,
        });
      } else if (!options.targetReceiver) {
        // Retention deliberately precedes native staging. An absent journal can
        // admit only the exact authenticated source, not an unjournaled target.
        await verifyRecipeUpdateInstallation(recipe, expected.installationRoot, "source");
      } else {
        throw new Error("Installed target resume has lost its original publication journal.");
      }
      assertCurrent();
    },
    readReceipts: async (selected) => {
      requireRetained(selected);
      const maintenance = await readUpgradeRecipeMaintenanceReceipt({ path: ledgerPath, env });
      assertCurrent();
      const steps = [];
      for (const binding of selected.stepBindings) {
        const receipt = await runSqliteReadOnlyOperation(
          ledgerPath,
          { type: "upgradeRecipeSteps.read", input: binding },
          { source: "canonical", expectedIdentity: context.admission.identity.key, env },
        );
        assertCurrent();
        if (receipt) {
          steps.push(receipt);
        }
      }
      return { maintenance, steps };
    },
  });
  return {
    recipe,
    env,
    retained,
    ports,
    hasPublication,
    bindNativeFence: (fence: UpdateRecoveryFence) => {
      if (liveFence && liveFence !== fence) {
        throw new Error(
          "Recipe recovery cannot substitute its already admitted original executor.",
        );
      }
      liveFence = fence;
      assertRecipeUpdateBinding(recipe, retained.binding.installationKey, runId, fence);
      if (options.targetReceiver && recipe.releaseQualification) {
        bindReleaseQualificationTargetReceiver(recipe, fence, options.runnerEntryUrl);
      }
      assertCurrent();
    },
  };
}
