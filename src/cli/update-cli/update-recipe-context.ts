import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { createConfigIO } from "../../config/io.factory.js";
import { resolveConfigPath, resolveStateDir } from "../../config/paths.js";
import { stableConfigStringify } from "../../config/runtime-config-snapshot-match.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { resolveExecutablePath } from "../../infra/executable-path.js";
import {
  resolveGlobalInstallTarget,
  type ResolvedGlobalInstallTarget,
} from "../../infra/update-global.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { UpdateSnapshotCapacitySchema } from "../../infra/update-snapshot-capacity-schema.js";
import {
  authenticateUpgradeRecipeCatalog,
  assertRecoveredUpgradeRecipeCatalogBinding,
  assertUpgradeRecipeCatalogCurrent,
  type AuthenticatedUpgradeRecipeCatalog,
} from "../../infra/upgrade-recipes/catalog.js";
import { upgradeRecipeExecutionCapacitySchema } from "../../infra/upgrade-recipes/execution-capacity.js";
import {
  verifyAuthenticatedUpgradeInstallation,
  type UpgradeInstallationIdentity,
} from "../../infra/upgrade-recipes/installation-identity.js";
import {
  verifyUpgradeRecipeRunnerBundle,
  type VerifiedUpgradeRecipeRunnerBundle,
} from "../../infra/upgrade-recipes/runner-bundle.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { assertReleaseQualificationCustody } from "./recipe-first-qualification.js";
import { releaseQualificationBindingSchema } from "./recipe-release-qualification-contract.js";
import { captureUpdateCommandExecutorAuthority } from "./update-command-executor.js";
import { updateRecipeMaintenanceInputSchema } from "./update-recipe-maintenance-contract.js";

export const UPDATE_RECIPE_UPDATE_CAPABILITY = "openclaw.upgrade-recipe-update.v1" as const;
const identity = z.string().min(1).max(4096);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const absoluteOwnerPath = identity.refine(
  (value) => path.isAbsolute(value) && path.resolve(value) === value,
);
const recipePackageOwnerSchema = z.strictObject({
  manager: z.literal("npm"),
  command: absoluteOwnerPath,
  globalRoot: absoluteOwnerPath,
  packageRoot: absoluteOwnerPath,
  directNodeModulesRoot: z.boolean().optional(),
  npmOwner: z.strictObject({
    version: identity,
    lifecyclePolicy: z.enum(["unflagged", "allow-scripts-advisory", "allow-scripts"]),
  }),
});

/** Exact approved facts carried through the existing engine; never execution authority. */
export const recipeUpdateContextSchema = z.strictObject({
  capability: z.literal(UPDATE_RECIPE_UPDATE_CAPABILITY),
  approvedPlanDigest: digest,
  approvedPlan: z.record(z.string(), z.json()),
  runner: z.strictObject({
    root: identity,
    manifestArtifactId: identity,
    manifestDigest: digest,
    closureDigest: digest,
  }),
  catalogDigest: digest,
  catalog: z.strictObject({
    controlRoot: identity,
    metadataDir: identity,
    metadataBaseUrl: identity,
    targetBaseUrl: identity,
    targetPath: identity,
    forbiddenRoots: z.array(identity).min(1),
  }),
  releaseQualification: releaseQualificationBindingSchema.optional(),
  sourceReleaseId: identity,
  targetReleaseId: identity,
  route: z.strictObject({
    recipe: z.strictObject({ id: identity, revision: z.number().int().positive() }),
    qualificationId: identity.optional(),
    installKind: z.enum(["npm", "pnpm", "bun"]),
    stateContractClass: identity,
    platform: z.strictObject({
      os: z.enum(["linux", "darwin", "win32"]),
      arch: z.enum(["x64", "arm64"]),
      serviceMode: z.enum(["systemd", "launchd", "windows-service", "windows-task"]),
    }),
  }),
  artifactsDirectory: identity,
  localArchivePath: identity,
  packageOwner: recipePackageOwnerSchema,
  targetSchemaVersions: z.strictObject({
    state: z.number().int().nonnegative(),
    agent: z.number().int().nonnegative(),
  }),
  sourceStateVersions: updateRecipeMaintenanceInputSchema.shape.stateVersions,
  service: z.strictObject({
    scope: z.enum(["user", "system"]),
    unitName: identity,
    managerUid: z.number().int().nonnegative().safe(),
    beforeDefinitionFingerprint: digest,
  }),
  planningEvidence: z.strictObject({
    rehearsal: z.strictObject({
      sourceStateVersions: updateRecipeMaintenanceInputSchema.shape.stateVersions,
      stateVersions: updateRecipeMaintenanceInputSchema.shape.stateVersions,
      candidateSchemaVersions: z.strictObject({
        state: z.number().int().nonnegative(),
        agent: z.number().int().nonnegative(),
      }),
      gatewayRestartCompletion: z.literal(true),
      listenerIsolation: z.strictObject({
        gateway: z.strictObject({
          host: z.literal("127.0.0.1"),
          port: z.number().int().min(1).max(65535),
        }),
        mcpAppSandbox: z.literal("disabled"),
      }),
      doctorConfigWrites: z.literal(false),
    }),
    snapshotCapacity: UpdateSnapshotCapacitySchema,
    executionCapacity: upgradeRecipeExecutionCapacitySchema,
  }),
  maintenance: updateRecipeMaintenanceInputSchema.omit({ executor: true, capability: true }),
});
export type RecipeUpdateContext = z.infer<typeof recipeUpdateContextSchema>;

/** Pin native PATH selection, then have the same owner probe that exact executable. */
export async function resolveRecipeUpdatePackageTarget(
  target: ResolvedGlobalInstallTarget,
  root: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedGlobalInstallTarget> {
  if (target.manager !== "npm") {
    throw new Error("Recipe requires the actual native npm owner.");
  }
  const executable = resolveExecutablePath(target.command, { env, useCache: false });
  if (!executable) {
    throw new Error("Recipe cannot pin the native npm launcher.");
  }
  const command = await fs.realpath(executable);
  const pinned = await resolveGlobalInstallTarget({
    manager: { manager: "npm", command },
    runCommand: runCommandWithTimeout,
    timeoutMs,
    pkgRoot: root,
    honorPackageRoot: true,
    env,
  });
  const owner = recipeUpdatePackageOwner(pinned);
  if (
    pinned.command !== command ||
    pinned.packageRoot !== root ||
    (await fs.realpath(owner.globalRoot)) !== owner.globalRoot ||
    (await fs.realpath(root)) !== root
  ) {
    throw new Error("Recipe npm owner changed its canonical destination or exact launcher.");
  }
  return pinned;
}

/** Projection of the existing native owner, not a second npm policy resolver. */
export function recipeUpdatePackageOwner(
  target: ResolvedGlobalInstallTarget,
): RecipeUpdateContext["packageOwner"] {
  if (target.npmOwner?.probeError || target.pnpmIsolated) {
    throw new Error("Recipe package owner has unresolved or unsupported native policy.");
  }
  return recipePackageOwnerSchema.parse(target);
}

export function assertRecipeUpdatePackageOwner(
  recipe: Pick<RecipeUpdateContext, "packageOwner" | "maintenance">,
  target: ResolvedGlobalInstallTarget | undefined,
): void {
  if (
    !target ||
    !isDeepStrictEqual(recipe.packageOwner, recipeUpdatePackageOwner(target)) ||
    recipe.packageOwner.packageRoot !== recipe.maintenance.expected.installationRoot
  ) {
    throw new Error(
      "Native package prefix, launcher, destination, or lifecycle policy differs from approval.",
    );
  }
}
/** Artifact verification selectors are evidence-only and usable before plan approval exists. */
export type RecipeUpdateArtifactSelectors = Pick<
  RecipeUpdateContext,
  | "releaseQualification"
  | "catalog"
  | "catalogDigest"
  | "sourceReleaseId"
  | "targetReleaseId"
  | "runner"
  | "route"
  | "targetSchemaVersions"
  | "artifactsDirectory"
  | "maintenance"
  | "localArchivePath"
>;
const admissions = new WeakMap<
  RecipeUpdateArtifactSelectors,
  Promise<AuthenticatedUpgradeRecipeCatalog>
>();
export const RECIPE_UPDATE_BUILTIN_ACTIONS = [
  {
    id: "core.package-publish",
    phase: "quiesced-migrate",
    mutation: "live-state",
    resources: [
      { kind: "package", scope: "installation", access: "write" },
      { kind: "state-db", scope: "active-profile", access: "write" },
      { kind: "configuration", scope: "active-profile", access: "read" },
    ],
    recovery: {
      mode: "transactional-reconcile",
      contractId: "core.package-publication.v1",
      snapshotRequired: true,
    },
    postconditionContractId: "core.authenticated-package.v1",
  },
  {
    id: "core.gateway-maintenance",
    phase: "postpublish-maintenance",
    mutation: "live-state",
    resources: [
      { kind: "state-db", scope: "active-profile", access: "write" },
      { kind: "configuration", scope: "active-profile", access: "read" },
    ],
    recovery: {
      mode: "transactional-reconcile",
      contractId: "core.gateway-maintenance.v1",
      snapshotRequired: false,
    },
    postconditionContractId: "core.target-committed.v1",
  },
  {
    id: "core.service-verify",
    phase: "verify",
    mutation: "live-state",
    resources: [{ kind: "service-definition", scope: "installation", access: "write" }],
    recovery: {
      mode: "transactional-reconcile",
      contractId: "core.service-verify.v1",
      snapshotRequired: false,
    },
    postconditionContractId: "core.managed-service-ready.v1",
  },
] as const;

/** Facts included in the explicit plan approval, excluding only the self-referential digest. */
export function recipeUpdateApprovalFacts(
  recipe: Omit<RecipeUpdateContext, "approvedPlan" | "approvedPlanDigest">,
) {
  const { planDigest: _planDigest, ...binding } = recipe.maintenance.binding;
  return { ...recipe, maintenance: { ...recipe.maintenance, binding } };
}

export function assertRecipeUpdateBinding(
  recipe: RecipeUpdateContext,
  root: string,
  runId: string | undefined,
  fence?: UpdateRecoveryFence,
): void {
  recipeUpdateContextSchema.parse(recipe);
  if (
    process.platform !== "linux" ||
    recipe.route.platform.os !== process.platform ||
    recipe.route.platform.arch !== process.arch ||
    recipe.route.installKind !== "npm" ||
    recipe.route.platform.serviceMode !== "systemd"
  ) {
    throw new Error(
      "Recipe execution is qualified only for the actual Linux/npm/systemd platform and architecture.",
    );
  }
  const { digest: planDigest, ...plan } = recipe.approvedPlan;
  const { approvedPlan: _approvedPlan, approvedPlanDigest: _approvedPlanDigest, ...facts } = recipe;
  const actions = [
    "publish-authenticated-package",
    "target-maintenance-commit",
    "verify-managed-service",
  ];
  if (
    planDigest !== recipe.approvedPlanDigest ||
    createHash("sha256").update(stableConfigStringify(plan)).digest("hex") !== planDigest ||
    plan.kind !== "executable" ||
    plan.mutationEnabled !== true ||
    JSON.stringify(plan.actions) !== JSON.stringify(actions) ||
    !isDeepStrictEqual(plan.facts, recipeUpdateApprovalFacts(facts))
  ) {
    throw new Error("Recipe plan bytes differ from their original approved digest.");
  }
  if (
    !isDeepStrictEqual(
      recipe.planningEvidence.rehearsal.sourceStateVersions,
      recipe.sourceStateVersions,
    ) ||
    !isDeepStrictEqual(
      recipe.planningEvidence.rehearsal.stateVersions,
      recipe.maintenance.stateVersions,
    ) ||
    !isDeepStrictEqual(
      recipe.planningEvidence.rehearsal.candidateSchemaVersions,
      recipe.targetSchemaVersions,
    )
  ) {
    throw new Error(
      "Recipe state contracts differ from actual approved private rehearsal evidence.",
    );
  }
  const { binding, expected } = recipe.maintenance;
  if (
    binding.runId !== runId ||
    binding.installationKey !== root ||
    expected.installationRoot !== root ||
    binding.stateRootKey !== expected.stateRoot ||
    binding.planDigest !== recipe.approvedPlanDigest ||
    !path.isAbsolute(root) ||
    path.normalize(root) !== root
  ) {
    throw new Error(
      "Recipe update changed its approved run, plan, installation, or state selectors.",
    );
  }
  if (fence) {
    const authority = captureUpdateCommandExecutorAuthority(fence, binding.runId);
    if (authority.installKey !== root) {
      throw new Error("Recipe update lost its selected native installation executor.");
    }
    fence.assertCurrent();
  }
}

/** Register only the exact durable original-run admission returned by the trust owner. */
export function bindRecoveredRecipeUpdateCatalog(
  recipe: RecipeUpdateContext,
  catalog: AuthenticatedUpgradeRecipeCatalog,
): void {
  assertRecoveredUpgradeRecipeCatalogBinding(catalog, recipe.maintenance.binding);
  if (catalog.digest !== recipe.catalogDigest) {
    throw new Error("Recovered recipe catalog differs from the original approved plan.");
  }
  admissions.set(recipe, Promise.resolve(catalog));
}

export async function resolveAuthenticatedRecipeUpdateCatalog(
  recipe: RecipeUpdateArtifactSelectors,
) {
  let admission = admissions.get(recipe);
  if (!admission) {
    admission = authenticateUpgradeRecipeCatalog(recipe.catalog);
    admissions.set(recipe, admission);
  }
  const catalog = await admission;
  if (catalog.digest !== recipe.catalogDigest) {
    throw new Error("Recipe catalog changed after plan approval; replan before execution.");
  }
  assertUpgradeRecipeCatalogCurrent(catalog);
  const source = catalog.catalog.releases.find((entry) => entry.id === recipe.sourceReleaseId);
  const target = catalog.catalog.releases.find((entry) => entry.id === recipe.targetReleaseId);
  const route = catalog.catalog.recipes.find(
    (entry) =>
      entry.id === recipe.route.recipe.id && entry.revision === recipe.route.recipe.revision,
  );
  const qualification = catalog.catalog.qualifications.find(
    (entry) => entry.id === recipe.route.qualificationId,
  );
  if (recipe.releaseQualification) {
    await assertReleaseQualificationCustody(recipe, catalog);
  }
  const runnerArtifact = catalog.catalog.artifacts.find(
    (entry) => entry.id === recipe.runner.manifestArtifactId,
  );
  if (
    !source ||
    !target ||
    target.artifactId !== recipe.maintenance.binding.targetArtifactId ||
    target.version !== recipe.maintenance.expected.version ||
    target.buildId !== recipe.maintenance.expected.buildId ||
    target.stateContracts.state !== recipe.targetSchemaVersions.state ||
    target.stateContracts.agent !== recipe.targetSchemaVersions.agent
  ) {
    throw new Error("Recipe target facts differ from the authenticated catalog.");
  }
  if (
    !route ||
    route.purpose !== "production" ||
    (recipe.releaseQualification &&
      (!isDeepStrictEqual(recipe.releaseQualification.recipe, recipe.route.recipe) ||
        recipe.route.qualificationId !== undefined)) ||
    route.executor.protocol !== 1 ||
    !isDeepStrictEqual(route.executor.requiredCapabilities, [
      UPDATE_RECIPE_UPDATE_CAPABILITY,
      "openclaw.upgrade-maintenance.v1",
    ]) ||
    !runnerArtifact ||
    runnerArtifact.sha256 !== recipe.runner.manifestDigest ||
    !route.source.releaseIds.includes(source.id) ||
    !route.targetReleaseIds.includes(target.id) ||
    !route.source.identityClasses.includes("verified-release") ||
    !route.source.installKinds.includes(recipe.route.installKind) ||
    !route.source.stateContractClasses.includes(recipe.route.stateContractClass) ||
    !route.source.platforms.some((entry) => isDeepStrictEqual(entry, recipe.route.platform)) ||
    (!recipe.releaseQualification &&
      (!qualification ||
        qualification.executor?.runnerManifestArtifactId !== recipe.runner.manifestArtifactId ||
        qualification.recipe.id !== route.id ||
        qualification.recipe.revision !== route.revision ||
        qualification.sourceReleaseId !== source.id ||
        qualification.targetReleaseId !== target.id ||
        qualification.installKind !== recipe.route.installKind ||
        qualification.runtimeFamily !== "node" ||
        qualification.stateContractClass !== recipe.route.stateContractClass ||
        !isDeepStrictEqual(qualification.platform, recipe.route.platform) ||
        !route.qualificationIds.includes(qualification.id))) ||
    source.runtimeFamily !== "node" ||
    target.runtimeFamily !== "node" ||
    route.steps.length !== RECIPE_UPDATE_BUILTIN_ACTIONS.length
  ) {
    throw new Error("Recipe update lacks an exact production-qualified built-in route.");
  }
  for (const [index, action] of RECIPE_UPDATE_BUILTIN_ACTIONS.entries()) {
    const step = route.steps[index]!;
    const adapter = catalog.catalog.adapters.find(
      (entry) =>
        entry.id === step.adapter.id &&
        entry.revision === step.adapter.revision &&
        entry.bundleArtifactId === step.adapter.bundleArtifactId &&
        entry.parameterContractId === step.adapter.parameterContractId,
    );
    if (
      !adapter ||
      step.adapter.id !== action.id ||
      step.adapter.revision !== 1 ||
      step.phase !== action.phase ||
      step.mutation !== action.mutation ||
      !isDeepStrictEqual(step.recovery, action.recovery) ||
      Object.keys(step.parameters).length !== 0 ||
      !isDeepStrictEqual(step.resources, action.resources) ||
      !isDeepStrictEqual(step.postconditionContractIds, [action.postconditionContractId]) ||
      step.adapter.bundleArtifactId !== recipe.runner.manifestArtifactId ||
      adapter.parameterContract !== "empty-object" ||
      !adapter.phases.includes(step.phase) ||
      !isDeepStrictEqual(step.requires, index === 0 ? [] : [route.steps[index - 1]!.id])
    ) {
      throw new Error(
        "Recipe update cannot execute an unsupported adapter, phase, parameter, recovery, or postcondition contract.",
      );
    }
  }
  assertUpgradeRecipeCatalogCurrent(catalog, {
    recipe: recipe.route.recipe,
    artifactIds: [
      source.artifactId,
      target.artifactId,
      ...(qualification ? [qualification.evidenceArtifactId] : []),
      recipe.runner.manifestArtifactId,
      ...route.steps.map((step) => step.adapter.bundleArtifactId),
    ],
  });
  return catalog;
}

export async function verifyRecipeUpdateRunner(
  recipe: Pick<
    RecipeUpdateArtifactSelectors,
    "runner" | "catalog" | "maintenance" | "route" | "releaseQualification"
  >,
  catalog: AuthenticatedUpgradeRecipeCatalog,
): Promise<VerifiedUpgradeRecipeRunnerBundle> {
  const runner = await verifyUpgradeRecipeRunnerBundle({
    catalog,
    bundleRoot: recipe.runner.root,
    manifestArtifactId: recipe.runner.manifestArtifactId,
    forbiddenRoots: recipe.catalog.forbiddenRoots,
  });
  const executor = catalog.catalog.qualifications.find(
    (entry) => entry.id === recipe.route.qualificationId,
  )?.executor;
  if (
    runner.manifestDigest !== recipe.runner.manifestDigest ||
    runner.closureDigest !== recipe.runner.closureDigest ||
    runner.runtimePath !== recipe.maintenance.expected.runtimeExecutable ||
    (!recipe.releaseQualification &&
      (!executor ||
        executor.runnerManifestArtifactId !== recipe.runner.manifestArtifactId ||
        executor.runtimeArtifactId !== runner.runtimeArtifactId ||
        executor.bootstrapArtifactId !== runner.bootstrapArtifactId))
  ) {
    throw new Error(
      "Recipe runtime or retained runner closure differs from the approved authenticated artifacts.",
    );
  }
  return runner;
}

/** Rehash named local bytes immediately before staging/publication, without registry resolution. */
export async function verifyRecipeUpdateArchive(
  recipe: RecipeUpdateArtifactSelectors,
): Promise<void> {
  const catalog = await resolveAuthenticatedRecipeUpdateCatalog(recipe);
  await verifyRecipeUpdateRunner(recipe, catalog);
  const artifact = catalog.catalog.artifacts.find(
    (entry) => entry.id === recipe.maintenance.binding.targetArtifactId,
  );
  if (
    !artifact ||
    (await fs.realpath(recipe.localArchivePath)) !== recipe.localArchivePath ||
    !path.isAbsolute(recipe.localArchivePath)
  ) {
    throw new Error("Recipe package archive is not an exact canonical local artifact.");
  }
  const directory = await fs.realpath(recipe.artifactsDirectory);
  const relative = path.relative(directory, recipe.localArchivePath);
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Recipe archive must remain inside its private external artifact storage.");
  }
  const handle = await fs.open(recipe.localArchivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    const hash = createHash("sha256");
    let length = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      length += chunk.length;
      if (length > artifact.length) {
        throw new Error("Recipe archive exceeds its authenticated length.");
      }
      hash.update(chunk);
    }
    const after = await handle.stat();
    const named = await fs.lstat(recipe.localArchivePath);
    if (
      !before.isFile() ||
      before.size !== artifact.length ||
      length !== artifact.length ||
      hash.digest("hex") !== artifact.sha256 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.ctimeMs !== after.ctimeMs ||
      before.mtimeMs !== after.mtimeMs ||
      named.dev !== after.dev ||
      named.ino !== after.ino ||
      named.isSymbolicLink()
    ) {
      throw new Error("Recipe archive bytes or filesystem generation changed.");
    }
  } finally {
    await handle.close();
  }
  assertUpgradeRecipeCatalogCurrent(catalog, { artifactIds: [artifact.id] });
}

export async function verifyRecipeUpdateInstallation(
  recipe: RecipeUpdateArtifactSelectors,
  root: string,
  release: "source" | "target",
): Promise<UpgradeInstallationIdentity> {
  const catalog = await resolveAuthenticatedRecipeUpdateCatalog(recipe);
  await verifyRecipeUpdateRunner(recipe, catalog);
  return await verifyAuthenticatedUpgradeInstallation({
    catalog,
    root,
    releaseId: release === "source" ? recipe.sourceReleaseId : recipe.targetReleaseId,
    artifactsDirectory: recipe.artifactsDirectory,
    forbiddenRoots: recipe.catalog.forbiddenRoots,
  });
}

/** Deterministic binding facts from the authentication owner, never caller-invented adapter hashes. */
export async function resolveRecipeUpdateStepCatalogFacts(recipe: RecipeUpdateContext) {
  const catalog = await resolveAuthenticatedRecipeUpdateCatalog(recipe);
  const source = catalog.catalog.releases.find((entry) => entry.id === recipe.sourceReleaseId)!;
  const target = catalog.catalog.releases.find((entry) => entry.id === recipe.targetReleaseId)!;
  const route = catalog.catalog.recipes.find(
    (entry) =>
      entry.id === recipe.route.recipe.id && entry.revision === recipe.route.recipe.revision,
  )!;
  const manifestDigest = (artifactId: string | undefined) => {
    const artifact = catalog.catalog.artifacts.find((entry) => entry.id === artifactId);
    if (!artifact) {
      throw new Error("Recipe step lacks its authenticated installed-manifest fingerprint.");
    }
    return artifact.sha256;
  };
  return {
    sourceManifestDigest: manifestDigest(source.installationManifestArtifactId),
    targetManifestDigest: manifestDigest(target.installationManifestArtifactId),
    steps: route.steps.map((step) => {
      const artifact = catalog.catalog.artifacts.find(
        (entry) => entry.id === step.adapter.bundleArtifactId,
      );
      if (!artifact) {
        throw new Error("Recipe step lacks its authenticated implementation artifact.");
      }
      return Object.assign({}, step, { adapterArtifactDigest: artifact.sha256 });
    }),
  };
}

export function assertRecipeUpdateConfig(
  recipe: Pick<RecipeUpdateContext, "maintenance">,
  snapshot: ConfigFileSnapshot,
): void {
  const { expected } = recipe.maintenance;
  if (
    !snapshot.valid ||
    snapshot.path !== expected.configPath ||
    snapshot.hash !== expected.configHash ||
    createHash("sha256").update(stableConfigStringify(snapshot.sourceConfig)).digest("hex") !==
      expected.configSourceDigest
  ) {
    throw new Error("Recipe configuration differs from the exact approved snapshot.");
  }
}

export function assertRecipeUpdateEnvironment(
  recipe: Pick<RecipeUpdateContext, "maintenance">,
  env: NodeJS.ProcessEnv,
): void {
  const expected = recipe.maintenance.expected;
  if (
    resolveStateDir(env) !== expected.stateRoot ||
    resolveConfigPath(env) !== expected.configPath ||
    (env.OPENCLAW_PROFILE ?? "default") !== expected.profile
  ) {
    throw new Error(
      "Recipe update environment differs from its approved state, configuration, or profile.",
    );
  }
}

export async function verifyRecipeUpdateConfig(
  recipe: RecipeUpdateContext,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  assertRecipeUpdateEnvironment(recipe, env);
  const snapshot = await createConfigIO({
    configPath: recipe.maintenance.expected.configPath,
    env,
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshot();
  assertRecipeUpdateConfig(recipe, snapshot);
  const { assertGatewayPluginFreeMaintenanceConfig } =
    await import("../../infra/upgrade-recipes/maintenance-config.js");
  assertGatewayPluginFreeMaintenanceConfig(snapshot.config);
}
