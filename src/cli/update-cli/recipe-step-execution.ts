import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createConfigIO } from "../../config/io.factory.js";
import { resolveStateDir } from "../../config/paths.js";
import { stableConfigStringify } from "../../config/runtime-config-snapshot-match.js";
import { isGatewayServiceStateLive } from "../../daemon/service-runtime.js";
import { resolveGatewayService } from "../../daemon/service.js";
import {
  readUpdateStateSchemaVersions,
  resolveUpdateStateContentVersion,
  type UpdateStateSchemaVersion,
} from "../../infra/update-candidate-state.js";
import { getUpdateRunAsync } from "../../infra/update-run-ledger.js";
import type { UpdateRunWriteOptions } from "../../infra/update-run-write.async.js";
import { readUpgradeRecipeMaintenanceReceipt } from "../../infra/upgrade-recipes/maintenance.js";
import {
  parseUpgradeRecipeStepBinding,
  type UpgradeRecipeStepBinding,
  type UpgradeRecipeStepObservation,
} from "../../infra/upgrade-recipes/receipts-contract.js";
import { createFencedUpgradeRecipeStepReceiptRecorder } from "../../infra/upgrade-recipes/receipts-worker.js";
import { UpdateCommandRecipeReconciliationPendingError } from "./update-command-recovery-error.js";
import { readGatewayServiceStateForUpdate } from "./update-command-service-plan.js";
import { revalidateManagedGatewayServiceAfterUpdate } from "./update-command-service.js";
import {
  assertRecipeUpdateBinding,
  assertRecipeUpdateConfig,
  assertRecipeUpdateEnvironment,
  resolveRecipeUpdateStepCatalogFacts,
  verifyRecipeUpdateInstallation,
  type RecipeUpdateContext,
} from "./update-recipe-context.js";

type Step = "core.package-publish" | "core.gateway-maintenance" | "core.service-verify";
type Resource = UpgradeRecipeStepBinding["resources"][number];
type Owner = UpdateRunWriteOptions & {
  env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
  assertEffectsSettled: () => void;
};
function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableConfigStringify(value)).digest("hex");
}
function versions(entries: readonly UpdateStateSchemaVersion[]) {
  const selected = entries
    .map((entry) => ({ path: entry.path, version: resolveUpdateStateContentVersion(entry) }))
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (new Set(selected.map((entry) => entry.path)).size !== selected.length) {
    throw new Error("Recipe state contract observations contain duplicate resource selectors.");
  }
  return selected;
}
function resource(
  recipe: RecipeUpdateContext,
  key: string,
  before: unknown,
  after: unknown,
): Resource {
  return {
    resourceKey: key,
    identityDigest: fingerprint({
      contract: "recipe-resource.v1",
      installation: recipe.maintenance.binding.installationKey,
      stateRoot: recipe.maintenance.binding.stateRootKey,
      profile: recipe.maintenance.expected.profile,
      key,
    }),
    beforeDigest: fingerprint(before),
    expectedAfterDigest: fingerprint(after),
  };
}
function configState(recipe: RecipeUpdateContext) {
  const { configHash, configSourceDigest } = recipe.maintenance.expected;
  return { contract: "approved-config-snapshot.v1", configHash, configSourceDigest };
}
function databaseResources(
  recipe: RecipeUpdateContext,
  before: readonly UpdateStateSchemaVersion[],
  after: readonly UpdateStateSchemaVersion[],
) {
  const previous = new Map(versions(before).map((entry) => [entry.path, entry.version]));
  const next = new Map(versions(after).map((entry) => [entry.path, entry.version]));
  const paths = [...new Set([...previous.keys(), ...next.keys()])].toSorted();
  // These are observed schema-contract fingerprints, not a claim to hash user data.
  return paths.map((path) =>
    resource(
      recipe,
      `state-contract:${path}`,
      { contract: "sqlite-state-contract.v1", path, version: previous.get(path) ?? null },
      { contract: "sqlite-state-contract.v1", path, version: next.get(path) ?? null },
    ),
  );
}
function serviceIdentity(recipe: RecipeUpdateContext) {
  const { scope, unitName, managerUid } = recipe.service;
  return {
    contract: "systemd-target.v1",
    scope,
    unitName,
    managerUid,
    installationRoot: recipe.maintenance.expected.installationRoot,
    stateRoot: recipe.maintenance.expected.stateRoot,
    configPath: recipe.maintenance.expected.configPath,
    profile: recipe.maintenance.expected.profile,
    port: recipe.maintenance.port,
  };
}
function serviceReady(recipe: RecipeUpdateContext) {
  return {
    ...serviceIdentity(recipe),
    contract: "verified-target-readiness.v1",
    version: recipe.maintenance.expected.version,
    buildId: recipe.maintenance.expected.buildId,
    serviceRunning: true,
    readyz: true,
    settled: true,
    versionMatch: true,
  };
}

/** Derive all receipt bindings from approved facts plus the exact authenticated implementation. */
export async function resolveRecipeStepBinding(
  recipe: RecipeUpdateContext,
  id: Step,
): Promise<UpgradeRecipeStepBinding> {
  const facts = await resolveRecipeUpdateStepCatalogFacts(recipe);
  const step = facts.steps.find((entry) => entry.adapter.id === id);
  if (!step) {
    throw new Error("Recipe execution lacks its exact approved built-in step.");
  }
  let resources: Resource[];
  const config = resource(
    recipe,
    `configuration:${recipe.maintenance.expected.configPath}`,
    configState(recipe),
    configState(recipe),
  );
  if (id === "core.package-publish") {
    resources = [
      resource(
        recipe,
        `package:${recipe.maintenance.expected.installationRoot}`,
        { contract: "authenticated-installation.v1", manifestDigest: facts.sourceManifestDigest },
        { contract: "authenticated-installation.v1", manifestDigest: facts.targetManifestDigest },
      ),
      ...databaseResources(recipe, recipe.sourceStateVersions, recipe.maintenance.stateVersions),
      config,
    ];
  } else if (id === "core.gateway-maintenance") {
    resources = [
      ...databaseResources(
        recipe,
        recipe.maintenance.stateVersions,
        recipe.maintenance.stateVersions,
      ),
      config,
      resource(
        recipe,
        `maintenance:${recipe.maintenance.expected.stateRoot}`,
        { binding: recipe.maintenance.binding, phase: "maintenance-required" },
        { binding: recipe.maintenance.binding, phase: "committed" },
      ),
    ];
  } else {
    resources = [
      resource(
        recipe,
        `service:${recipe.service.scope}:${recipe.service.unitName}`,
        {
          ...serviceIdentity(recipe),
          status: "stopped",
          definitionFingerprint: recipe.service.beforeDefinitionFingerprint,
        },
        serviceReady(recipe),
      ),
    ];
  }
  return parseUpgradeRecipeStepBinding({
    protocol: 1,
    runId: recipe.maintenance.binding.runId,
    planDigest: recipe.approvedPlanDigest,
    stepId: step.id,
    recipeId: recipe.route.recipe.id,
    recipeRevision: recipe.route.recipe.revision,
    adapterId: step.adapter.id,
    adapterRevision: step.adapter.revision,
    adapterArtifactDigest: step.adapterArtifactDigest,
    phase: step.phase,
    resources,
  });
}

async function observeConfigAndState(recipe: RecipeUpdateContext, owner: Owner) {
  owner.assertCurrent();
  assertRecipeUpdateEnvironment(recipe, owner.env);
  const snapshot = await createConfigIO({
    configPath: recipe.maintenance.expected.configPath,
    env: owner.env,
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshot();
  owner.assertCurrent();
  assertRecipeUpdateConfig(recipe, snapshot);
  const current = await readUpdateStateSchemaVersions({
    root: recipe.maintenance.expected.installationRoot,
    nodeRunner: recipe.maintenance.expected.runtimeExecutable,
    stateDir: resolveStateDir(owner.env),
    config: snapshot.config,
    env: owner.env,
    signal: owner.signal,
    timeoutMs: recipe.maintenance.timeoutMs,
  });
  owner.assertCurrent();
  return { snapshot, current };
}
async function recorder(recipe: RecipeUpdateContext, id: Step, owner: Owner) {
  assertRecipeUpdateBinding(
    recipe,
    recipe.maintenance.expected.installationRoot,
    recipe.maintenance.binding.runId,
  );
  owner.assertCurrent();
  const binding = await resolveRecipeStepBinding(recipe, id);
  owner.assertCurrent();
  return createFencedUpgradeRecipeStepReceiptRecorder(binding, owner);
}
async function prepareNew(recipe: RecipeUpdateContext, id: Step, owner: Owner) {
  const selected = await recorder(recipe, id, owner);
  const preparation = await selected.prepareIntent();
  if (preparation.kind !== "intent-recorded") {
    throw new UpdateCommandRecipeReconciliationPendingError(
      "Retained recipe step requires reconciliation by its original owner; fresh execution cannot replay it.",
    );
  }
}
async function reconcile(
  recipe: RecipeUpdateContext,
  id: Step,
  owner: Owner,
  observe: (binding: UpgradeRecipeStepBinding) => Promise<UpgradeRecipeStepObservation>,
) {
  const selected = await recorder(recipe, id, owner);
  const result = await selected.reconcile(() => observe(selected.binding));
  if (result.kind !== "verified") {
    throw new UpdateCommandRecipeReconciliationPendingError(
      "Recipe step postconditions are unresolved; preserve current state and resume its original owner.",
    );
  }
}
function observations(resources: Resource[]): UpgradeRecipeStepObservation {
  return {
    status: "observed",
    resources: resources.map((entry) => ({
      resourceKey: entry.resourceKey,
      identityDigest: entry.identityDigest,
      stateDigest: entry.expectedAfterDigest,
    })),
  };
}

export async function prepareRecipePackagePublication(
  recipe: RecipeUpdateContext,
  owner: Owner,
): Promise<void> {
  await verifyRecipeUpdateInstallation(
    recipe,
    recipe.maintenance.expected.installationRoot,
    "source",
  );
  owner.assertCurrent();
  const { current } = await observeConfigAndState(recipe, owner);
  if (!isDeepStrictEqual(versions(current), versions(recipe.sourceStateVersions))) {
    throw new Error(
      "Recipe package publication source state differs from its approved before image.",
    );
  }
  await prepareNew(recipe, "core.package-publish", owner);
}

export async function reconcileRecipePackagePublication(
  recipe: RecipeUpdateContext,
  owner: Owner,
): Promise<void> {
  await reconcile(recipe, "core.package-publish", owner, async () => {
    const installation = await verifyRecipeUpdateInstallation(
      recipe,
      recipe.maintenance.expected.installationRoot,
      "target",
    );
    owner.assertCurrent();
    const { current } = await observeConfigAndState(recipe, owner);
    return observations([
      resource(recipe, `package:${installation.root}`, null, {
        contract: "authenticated-installation.v1",
        manifestDigest: installation.manifestDigest,
      }),
      ...databaseResources(recipe, recipe.sourceStateVersions, current),
      resource(
        recipe,
        `configuration:${recipe.maintenance.expected.configPath}`,
        null,
        configState(recipe),
      ),
    ]);
  });
}

export async function prepareRecipeTargetMaintenance(
  recipe: RecipeUpdateContext,
  owner: Owner,
): Promise<void> {
  const { current } = await observeConfigAndState(recipe, owner);
  if (!isDeepStrictEqual(versions(current), versions(recipe.maintenance.stateVersions))) {
    throw new Error("Recipe maintenance state differs from its approved target contracts.");
  }
  const receipt = await readUpgradeRecipeMaintenanceReceipt({ env: owner.env });
  owner.assertCurrent();
  if (
    !receipt ||
    receipt.phase !== "maintenance-required" ||
    !isDeepStrictEqual(receipt.binding, recipe.maintenance.binding)
  ) {
    throw new UpdateCommandRecipeReconciliationPendingError(
      "Fresh recipe maintenance requires its exact prepublication exclusion; retained intent needs its original recovery owner.",
    );
  }
  await prepareNew(recipe, "core.gateway-maintenance", owner);
}

export async function reconcileRecipeTargetMaintenance(
  recipe: RecipeUpdateContext,
  owner: Owner,
): Promise<void> {
  await reconcile(recipe, "core.gateway-maintenance", owner, async () => {
    const receipt = await readUpgradeRecipeMaintenanceReceipt({ env: owner.env });
    owner.assertCurrent();
    if (
      !receipt ||
      receipt.phase !== "committed" ||
      !isDeepStrictEqual(receipt.binding, recipe.maintenance.binding)
    ) {
      return { status: "unavailable", resources: [] };
    }
    const { current } = await observeConfigAndState(recipe, owner);
    return observations([
      ...databaseResources(recipe, recipe.maintenance.stateVersions, current),
      resource(
        recipe,
        `configuration:${recipe.maintenance.expected.configPath}`,
        null,
        configState(recipe),
      ),
      resource(recipe, `maintenance:${recipe.maintenance.expected.stateRoot}`, null, {
        binding: receipt.binding,
        phase: receipt.phase,
      }),
    ]);
  });
}

export async function observeRecipeServiceForRecovery(recipe: RecipeUpdateContext, owner: Owner) {
  assertRecipeUpdateEnvironment(recipe, owner.env);
  const state = await readGatewayServiceStateForUpdate(
    resolveGatewayService(),
    owner.env,
    recipe.maintenance.timeoutMs,
    { managerUid: recipe.service.managerUid, assertCurrent: owner.assertCurrent },
  );
  assertRecipeUpdateEnvironment(recipe, state.env);
  owner.assertCurrent();
  const native = state.runtime?.systemd;
  if (
    !native ||
    native.scope !== recipe.service.scope ||
    native.unit !== recipe.service.unitName ||
    native.managerUid !== recipe.service.managerUid
  ) {
    throw new Error(
      "Recipe service receipt observed a different native manager, unit, or account.",
    );
  }
  const verdict = await revalidateManagedGatewayServiceAfterUpdate({
    state,
    root: recipe.maintenance.expected.installationRoot,
    allowInstallRootChange: false,
  });
  owner.assertCurrent();
  if (verdict.kind !== "owned") {
    throw new Error("Recipe service receipt cannot verify its actual target installation.");
  }
  if (verdict.fingerprint !== recipe.service.beforeDefinitionFingerprint) {
    throw new Error("Recipe service definition differs from explicit approval.");
  }
  return { state, verdict };
}
export async function prepareRecipeServiceActivation(
  recipe: RecipeUpdateContext,
  owner: Owner,
): Promise<void> {
  const { state } = await observeRecipeServiceForRecovery(recipe, owner);
  if (isGatewayServiceStateLive(state) || state.runtime?.status !== "stopped") {
    throw new Error("Recipe service activation differs from its approved stopped before image.");
  }
  await prepareNew(recipe, "core.service-verify", owner);
}
export async function reconcileRecipeServiceActivation(
  recipe: RecipeUpdateContext,
  owner: Owner,
  verifiedByNativeOwner: boolean,
): Promise<void> {
  await reconcile(recipe, "core.service-verify", owner, async () => {
    const run = await getUpdateRunAsync(recipe.maintenance.binding.runId, { env: owner.env });
    owner.assertCurrent();
    const proof = run?.verification;
    if (
      !verifiedByNativeOwner ||
      !proof ||
      proof.runningVersion !== recipe.maintenance.expected.version ||
      proof.runningBuildId !== recipe.maintenance.expected.buildId ||
      proof.port !== recipe.maintenance.port ||
      proof.versionMatch !== true ||
      proof.readyz !== true ||
      proof.settled !== true ||
      proof.serviceRunning !== true ||
      !Number.isSafeInteger(proof.pid) ||
      (proof.pid ?? 0) <= 0
    ) {
      return { status: "unavailable", resources: [] };
    }
    const { state } = await observeRecipeServiceForRecovery(recipe, owner);
    if (!state.running || state.runtime?.status !== "running" || state.runtime.pid !== proof.pid) {
      return { status: "unavailable", resources: [] };
    }
    return {
      ...observations([
        resource(recipe, `service:${recipe.service.scope}:${recipe.service.unitName}`, null, {
          ...serviceIdentity(recipe),
          contract: "verified-target-readiness.v1",
          version: proof.runningVersion,
          buildId: proof.runningBuildId,
          serviceRunning: proof.serviceRunning,
          readyz: proof.readyz,
          settled: proof.settled,
          versionMatch: proof.versionMatch,
        }),
      ]),
    };
  });
}
