import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createConfigIO } from "../../config/io.factory.js";
import { stableConfigStringify } from "../../config/runtime-config-snapshot-match.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { validateUpdateCandidateCanary } from "../../infra/update-candidate-canary.js";
import {
  readUpdateStateSchemaVersions,
  resolveUpdateStateContentVersion,
} from "../../infra/update-candidate-state.js";
import {
  detectGlobalInstallManagerForRoot,
  resolveGlobalInstallTarget,
  createGlobalInstallEnv,
} from "../../infra/update-global.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import {
  authenticateUpgradeRecipeCatalog,
  type AuthenticateUpgradeRecipeCatalogOptions,
} from "../../infra/upgrade-recipes/catalog.js";
import { measureUpgradeRecipeExecutionCapacity } from "../../infra/upgrade-recipes/execution-capacity.js";
import { verifyAuthenticatedUpgradeInstallation } from "../../infra/upgrade-recipes/installation-identity.js";
import {
  assertGatewayPluginFreeMaintenanceConfig,
  resolveGatewayUpgradeMaintenanceConfigIdentity,
} from "../../infra/upgrade-recipes/maintenance-config.js";
import { verifyUpgradeRecipeRunnerBundle } from "../../infra/upgrade-recipes/runner-bundle.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { verifyRecipeQualificationEvidence } from "./recipe-qualification.js";
import type { ReleaseQualificationBinding } from "./recipe-release-qualification-contract.js";
import { inspectUpdateManagedServices } from "./update-command-database-context.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  stagePackageInstallUpdate,
  type StagedPackageInstallUpdate,
} from "./update-command-package.js";
import { resolvePackageRuntimePreflight } from "./update-command-runtime-preflight.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";
import {
  inspectManagedGatewayServiceBeforeUpdate,
  readGatewayServiceStateForUpdate,
  resolveUpdatedGatewayRestartPort,
} from "./update-command-service-plan.js";
import {
  assertRecipeUpdateBinding,
  assertRecipeUpdateConfig,
  assertRecipeUpdateEnvironment,
  recipeUpdateApprovalFacts,
  recipeUpdateContextSchema,
  recipeUpdatePackageOwner,
  resolveRecipeUpdatePackageTarget,
  resolveAuthenticatedRecipeUpdateCatalog,
  UPDATE_RECIPE_UPDATE_CAPABILITY,
  verifyRecipeUpdateArchive,
  type RecipeUpdateArtifactSelectors,
  type RecipeUpdateContext,
} from "./update-recipe-context.js";

export type ExecutableRecipePlanOptions = {
  installationRoot: string;
  stateRoot: string;
  configPath: string;
  profile: string;
  port: number;
  catalog: AuthenticateUpgradeRecipeCatalogOptions;
  sourceReleaseId: string;
  targetReleaseId: string;
  qualificationId?: string;
  releaseQualification?: ReleaseQualificationBinding;
  runnerRoot: string;
  runnerManifestArtifactId: string;
  runnerEntryUrl: string;
  artifactsDirectory: string;
  localArchivePath: string;
  timeoutMs: number;
};
const placeholderDigest = "0".repeat(64);
function digest(value: unknown): string {
  return createHash("sha256").update(stableConfigStringify(value)).digest("hex");
}
async function canonical(value: string): Promise<string> {
  if (
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    (await fs.realpath(value)) !== value
  ) {
    throw new Error("Executable planning requires exact canonical owner-selected paths.");
  }
  return value;
}
function refuseLoaderSubstitution() {
  for (const key of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_AUDIT",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
    "OPENSSL_CONF",
  ]) {
    if (process.env[key]?.trim()) {
      throw new Error(`Executable planning refuses inherited runtime loader substitution: ${key}.`);
    }
  }
}
function normalizedVersions(entries: RecipeUpdateContext["sourceStateVersions"]) {
  return entries
    .map((entry) => ({ path: entry.path, version: resolveUpdateStateContentVersion(entry) }))
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Private staging/rehearsal composed with the native updater owner; never publishes or initializes live state. */
export async function prepareExecutableRecipePlan(
  options: ExecutableRecipePlanOptions,
): Promise<RecipeUpdateContext> {
  refuseLoaderSubstitution();
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
    throw new Error("Executable planning is qualified only for Linux/npm/systemd.");
  }
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    !Number.isSafeInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535 ||
    !options.profile
  ) {
    throw new Error("Executable planning requires an exact profile, port, and positive timeout.");
  }
  for (const selected of [
    options.installationRoot,
    options.stateRoot,
    options.configPath,
    options.artifactsDirectory,
    options.localArchivePath,
    options.runnerRoot,
    ...options.catalog.forbiddenRoots,
  ]) {
    await canonical(selected);
  }
  if (
    !options.catalog.forbiddenRoots.includes(options.installationRoot) ||
    !options.catalog.forbiddenRoots.includes(options.stateRoot)
  ) {
    throw new Error(
      "Executable planning boundaries must include the actual installation and selected live state root.",
    );
  }
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: options.stateRoot,
    OPENCLAW_CONFIG_PATH: options.configPath,
    OPENCLAW_PROFILE: options.profile,
  };
  const shared = await fs.lstat(resolveOpenClawStateSqlitePath(env)).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  if (!shared?.isFile()) {
    throw new Error(
      "Executable planning requires existing initialized shared state; it never initializes canonical state.",
    );
  }
  const catalog = await authenticateUpgradeRecipeCatalog(options.catalog);
  const source = catalog.catalog.releases.find((release) => release.id === options.sourceReleaseId);
  const target = catalog.catalog.releases.find((release) => release.id === options.targetReleaseId);
  const releaseRoute =
    options.releaseQualification &&
    catalog.catalog.recipes.find(
      (entry) =>
        entry.id === options.releaseQualification?.recipe.id &&
        entry.revision === options.releaseQualification.recipe.revision &&
        entry.purpose === "production" &&
        catalog.catalog.qualificationIntents?.some(
          (intent) =>
            intent.recipe.id === entry.id &&
            intent.recipe.revision === entry.revision &&
            intent.sourceReleaseId === options.sourceReleaseId &&
            intent.targetReleaseId === options.targetReleaseId &&
            intent.runnerManifestArtifactId === options.runnerManifestArtifactId,
        ),
    );
  const qualification = options.releaseQualification
    ? releaseRoute &&
      source &&
      target &&
      releaseRoute.source.stateContractClasses.length === 1 &&
      releaseRoute.source.platforms.length === 1 && {
        id: undefined,
        recipe: options.releaseQualification.recipe,
        sourceReleaseId: source.id,
        targetReleaseId: target.id,
        installKind: "npm" as const,
        platform: releaseRoute.source.platforms[0]!,
        runtimeFamily: "node" as const,
        stateContractClass: releaseRoute.source.stateContractClasses[0]!,
      }
    : catalog.catalog.qualifications.find((entry) => entry.id === options.qualificationId);
  if (
    !source ||
    !target ||
    !qualification ||
    qualification.sourceReleaseId !== source.id ||
    qualification.targetReleaseId !== target.id ||
    qualification.installKind !== "npm" ||
    qualification.platform.os !== process.platform ||
    qualification.platform.arch !== process.arch ||
    qualification.platform.serviceMode !== "systemd" ||
    qualification.runtimeFamily !== "node"
  ) {
    throw new Error(
      "Executable planning requires its exact authenticated production platform route.",
    );
  }
  const runner = await verifyUpgradeRecipeRunnerBundle({
    catalog,
    bundleRoot: options.runnerRoot,
    manifestArtifactId: options.runnerManifestArtifactId,
    forbiddenRoots: options.catalog.forbiddenRoots,
  });
  if (
    (await fs.realpath(process.execPath)) !== runner.runtimePath ||
    (await fs.realpath(fileURLToPath(options.runnerEntryUrl))) !==
      (options.releaseQualification
        ? runner.releaseQualificationEntrypointPath
        : runner.entrypointPath)
  ) {
    throw new Error(
      "Executable planning must run from the exact authenticated independent runner.",
    );
  }
  await verifyAuthenticatedUpgradeInstallation({
    catalog,
    root: options.installationRoot,
    releaseId: source.id,
    artifactsDirectory: options.artifactsDirectory,
    forbiddenRoots: options.catalog.forbiddenRoots,
  });
  const runId = randomUUID();
  return withOwnedManagedUpdateEnv(env, () =>
    withUpdateCommandExecutor(runId, async (executor) => {
      await assertUpdateRecoveryAdmission({ env });
      const managed = await inspectUpdateManagedServices({
        roots: [options.installationRoot],
        updateInstallKind: "package",
        shouldRestart: true,
        jsonMode: true,
        timeoutMs: options.timeoutMs,
        invocationCwd: options.artifactsDirectory,
        managedServiceRootRedirect: null,
      });
      if (managed.service?.serviceUpdateVerdict?.kind !== "owned") {
        throw new Error("Executable planning requires the actual owned managed Gateway service.");
      }
      const fence = await executor.enter(options.installationRoot, { preflight: true });
      const assertCurrent = () => fence.assertCurrent();
      const service = await readGatewayServiceStateForUpdate(
        resolveGatewayService(),
        env,
        options.timeoutMs,
        { managerUid: managed.service.serviceManagerUid, assertCurrent },
      );
      assertCurrent();
      const serviceVerdict = await inspectManagedGatewayServiceBeforeUpdate({
        state: service,
        root: options.installationRoot,
      });
      assertCurrent();
      const native = service.runtime?.systemd;
      if (
        serviceVerdict.kind !== "owned" ||
        !native?.scope ||
        !native.unit ||
        native.managerUid === undefined ||
        serviceVerdict.fingerprint !== managed.service.serviceUpdateVerdict.fingerprint
      ) {
        throw new Error(
          "Executable planning cannot bind the exact native service definition or manager.",
        );
      }
      const snapshot = await createConfigIO({
        configPath: options.configPath,
        env,
        observe: false,
        pluginValidation: "core-only",
      }).readConfigFileSnapshot();
      assertCurrent();
      if (!snapshot.valid || !snapshot.hash) {
        throw new Error(
          "Executable planning requires a valid exact authored configuration snapshot.",
        );
      }
      assertGatewayPluginFreeMaintenanceConfig(snapshot.config);
      const actualPort = await resolveUpdatedGatewayRestartPort({
        config: snapshot.config,
        processEnv: env,
        serviceEnv: service.env,
        serviceCommand: service.command,
      });
      assertCurrent();
      if (actualPort !== options.port) {
        throw new Error("Executable planning port differs from the actual managed launcher.");
      }
      const selectors: RecipeUpdateArtifactSelectors = {
        ...(options.releaseQualification
          ? { releaseQualification: options.releaseQualification }
          : {}),
        catalog: {
          controlRoot: options.catalog.controlRoot,
          metadataDir: options.catalog.metadataDir,
          metadataBaseUrl: options.catalog.metadataBaseUrl,
          targetBaseUrl: options.catalog.targetBaseUrl,
          targetPath: options.catalog.targetPath,
          forbiddenRoots: [...options.catalog.forbiddenRoots],
        },
        catalogDigest: catalog.digest,
        sourceReleaseId: source.id,
        targetReleaseId: target.id,
        runner: {
          root: runner.root,
          manifestArtifactId: options.runnerManifestArtifactId,
          manifestDigest: runner.manifestDigest,
          closureDigest: runner.closureDigest,
        },
        route: {
          recipe: qualification.recipe,
          qualificationId: qualification.id,
          installKind: "npm",
          stateContractClass: qualification.stateContractClass,
          platform: {
            os: "linux",
            arch: qualification.platform.arch,
            serviceMode: "systemd",
          },
        },
        artifactsDirectory: options.artifactsDirectory,
        localArchivePath: options.localArchivePath,
        targetSchemaVersions: target.stateContracts,
        maintenance: {
          binding: {
            protocol: 1,
            runId,
            planDigest: placeholderDigest,
            targetArtifactId: target.artifactId,
            installationKey: options.installationRoot,
            stateRootKey: options.stateRoot,
          },
          expected: {
            version: target.version,
            buildId: target.buildId,
            runtimeExecutable: runner.runtimePath,
            installationRoot: options.installationRoot,
            stateRoot: options.stateRoot,
            configPath: options.configPath,
            ...resolveGatewayUpgradeMaintenanceConfigIdentity(snapshot),
            profile: options.profile,
          },
          stateVersions: [],
          port: actualPort,
          timeoutMs: options.timeoutMs,
        },
      };
      assertRecipeUpdateEnvironment(selectors, env);
      assertRecipeUpdateEnvironment(selectors, service.env);
      await resolveAuthenticatedRecipeUpdateCatalog(selectors);
      await verifyRecipeQualificationEvidence(selectors, catalog);
      await verifyRecipeUpdateArchive(selectors);
      assertCurrent();
      const sourceVersions = await readUpdateStateSchemaVersions({
        root: options.installationRoot,
        nodeRunner: runner.runtimePath,
        env,
        stateDir: options.stateRoot,
        config: snapshot.config,
        timeoutMs: options.timeoutMs,
      });
      assertCurrent();
      const sharedPath = resolveOpenClawStateSqlitePath(env);
      if (
        !sourceVersions.length ||
        sourceVersions.some(
          (entry) =>
            resolveUpdateStateContentVersion(entry) !==
            (entry.path === sharedPath ? source.stateContracts.state : source.stateContracts.agent),
        )
      ) {
        throw new Error(
          "Actual source families do not match the qualified authenticated source state contracts.",
        );
      }
      const manager = await detectGlobalInstallManagerForRoot(
        runCommandWithTimeout,
        options.installationRoot,
        options.timeoutMs,
      );
      assertCurrent();
      if (manager !== "npm") {
        throw new Error(
          "Executable planning cannot substitute the installation's actual package manager.",
        );
      }
      let installTarget = await resolveGlobalInstallTarget({
        manager,
        runCommand: runCommandWithTimeout,
        timeoutMs: options.timeoutMs,
        pkgRoot: options.installationRoot,
        honorPackageRoot: true,
      });
      assertCurrent();
      installTarget = await resolveRecipeUpdatePackageTarget(
        installTarget,
        options.installationRoot,
        options.timeoutMs,
        env,
      );
      assertCurrent();
      if (installTarget.packageRoot !== options.installationRoot) {
        throw new Error("Executable planning package owner selected another installation.");
      }
      const packageOwner = recipeUpdatePackageOwner(installTarget);
      await canonical(packageOwner.globalRoot);
      await canonical(packageOwner.packageRoot);
      // The owner-selected launcher may itself be a normal npm symlink; pin its
      // canonical parent, preserving the exact native command rather than rebasing it.
      await canonical(path.dirname(packageOwner.command));
      assertCurrent();
      const installEnv = await createGlobalInstallEnv(env);
      assertCurrent();
      let stage: StagedPackageInstallUpdate | undefined;
      let outcome: { value: RecipeUpdateContext } | { error: unknown };
      try {
        stage = await stagePackageInstallUpdate({
          root: options.installationRoot,
          installKind: "package",
          tag: target.version,
          installSpec: options.localArchivePath,
          installTarget,
          installEnv,
          honorPackageRoot: true,
          nodeRunner: runner.runtimePath,
          managedServiceEnv: env,
          invocationCwd: options.artifactsDirectory,
          timeoutMs: options.timeoutMs,
          startedAt: Date.now(),
          progress: {},
          pauseBeforeVerification: true,
          beforeVerifyCandidate: async (root) => {
            await verifyAuthenticatedUpgradeInstallation({
              catalog,
              root,
              releaseId: target.id,
              artifactsDirectory: options.artifactsDirectory,
              forbiddenRoots: options.catalog.forbiddenRoots,
            });
            assertCurrent();
          },
        });
        assertCurrent();
        const runtime = await resolvePackageRuntimePreflight({
          installedRoot: stage.root,
          root: options.installationRoot,
          nodeRunner: runner.runtimePath,
          shouldRestart: false,
          timeoutMs: options.timeoutMs,
          invocationCwd: options.artifactsDirectory,
        });
        assertCurrent();
        if (!runtime.ok || runtime.value.nodeRunner !== runner.runtimePath) {
          throw new Error(
            "Exact candidate does not accept the authenticated private runner runtime.",
          );
        }
        const canary = await validateUpdateCandidateCanary({
          root: stage.root,
          config: snapshot.config,
          stateDir: options.stateRoot,
          env,
          nodeRunner: runner.runtimePath,
          timeoutMs: options.timeoutMs,
          assertCurrent,
          observeStateVersions: true,
        });
        assertCurrent();
        const observation = canary.stateObservation;
        const snapshotCapacity = canary.steps.find(
          (step) => step.snapshotCapacity,
        )?.snapshotCapacity;
        if (
          canary.status !== "ok" ||
          !observation ||
          !snapshotCapacity ||
          !canary.candidateSchemaVersions ||
          canary.gatewayRestartCompletion !== true ||
          !canary.listenerIsolation ||
          canary.doctorConfigWrites === true ||
          (canary.doctorConfigChanges?.length ?? 0) !== 0 ||
          !isDeepStrictEqual(canary.candidateSchemaVersions, target.stateContracts) ||
          !isDeepStrictEqual(
            normalizedVersions(sourceVersions),
            normalizedVersions(observation.sourceStateVersions),
          )
        ) {
          throw new Error(
            "Actual private rehearsal does not prove the exact supported state/config/startup contract.",
          );
        }
        const executionCapacity = await measureUpgradeRecipeExecutionCapacity({
          installationRoot: options.installationRoot,
          candidateRoot: stage.root,
          runnerRoot: runner.root,
          archivePath: options.localArchivePath,
          artifactsDirectory: options.artifactsDirectory,
          stateRoot: options.stateRoot,
          snapshotCapacity,
        });
        assertCurrent();
        const afterConfig = await createConfigIO({
          configPath: options.configPath,
          env,
          observe: false,
          pluginValidation: "core-only",
        }).readConfigFileSnapshot();
        assertCurrent();
        assertRecipeUpdateConfig(selectors, afterConfig);
        const afterService = await readGatewayServiceStateForUpdate(
          resolveGatewayService(),
          env,
          options.timeoutMs,
          { managerUid: native.managerUid, assertCurrent },
        );
        assertCurrent();
        assertRecipeUpdateEnvironment(selectors, afterService.env);
        const afterVerdict = await inspectManagedGatewayServiceBeforeUpdate({
          state: afterService,
          root: options.installationRoot,
        });
        assertCurrent();
        if (
          afterVerdict.kind !== "owned" ||
          afterVerdict.fingerprint !== serviceVerdict.fingerprint ||
          !isDeepStrictEqual(
            afterService.runtime?.systemd && {
              scope: afterService.runtime.systemd.scope,
              unit: afterService.runtime.systemd.unit,
              managerUid: afterService.runtime.systemd.managerUid,
            },
            { scope: native.scope, unit: native.unit, managerUid: native.managerUid },
          )
        ) {
          throw new Error("Native service facts changed during private plan preparation.");
        }
        await verifyRecipeUpdateArchive(selectors);
        await verifyAuthenticatedUpgradeInstallation({
          catalog,
          root: options.installationRoot,
          releaseId: source.id,
          artifactsDirectory: options.artifactsDirectory,
          forbiddenRoots: options.catalog.forbiddenRoots,
        });
        assertCurrent();
        const facts = {
          ...selectors,
          capability: UPDATE_RECIPE_UPDATE_CAPABILITY,
          packageOwner,
          sourceStateVersions: observation.sourceStateVersions,
          service: {
            scope: native.scope,
            unitName: native.unit,
            managerUid: native.managerUid,
            beforeDefinitionFingerprint: serviceVerdict.fingerprint,
          },
          maintenance: { ...selectors.maintenance, stateVersions: observation.stateVersions },
          planningEvidence: {
            rehearsal: {
              ...observation,
              candidateSchemaVersions: canary.candidateSchemaVersions,
              gatewayRestartCompletion: true as const,
              listenerIsolation: canary.listenerIsolation,
              doctorConfigWrites: false as const,
            },
            snapshotCapacity,
            executionCapacity,
          },
        };
        const plan = {
          kind: "executable",
          mutationEnabled: true,
          actions: [
            "publish-authenticated-package",
            "target-maintenance-commit",
            "verify-managed-service",
          ],
          facts: recipeUpdateApprovalFacts(facts),
        };
        const planDigest = digest(plan);
        const recipe = recipeUpdateContextSchema.parse({
          ...facts,
          approvedPlanDigest: planDigest,
          approvedPlan: { ...plan, digest: planDigest },
          maintenance: {
            ...facts.maintenance,
            binding: { ...facts.maintenance.binding, planDigest },
          },
        });
        assertRecipeUpdateBinding(recipe, options.installationRoot, runId, fence);
        outcome = { value: recipe };
      } catch (error) {
        outcome = { error };
      }
      try {
        await stage?.close();
        assertCurrent();
      } catch (cleanupError) {
        if ("error" in outcome) {
          throw new AggregateError(
            [outcome.error, cleanupError],
            "Executable plan preparation and stage cleanup failed",
            { cause: cleanupError },
          );
        }
        throw cleanupError;
      }
      if ("error" in outcome) {
        throw outcome.error;
      }
      return outcome.value;
    }),
  );
}

/** Named private plan artifact; never overwrite another owner or print authored configuration. */
export async function writeExecutableRecipePlan(
  filename: string,
  recipe: RecipeUpdateContext,
): Promise<void> {
  const output = path.resolve(filename);
  const relative = path.relative(recipe.artifactsDirectory, output);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      "Executable plan artifact must remain in its approved private retained artifact directory.",
    );
  }
  const parent = await canonical(path.dirname(output));
  const stat = await fs.lstat(parent);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error("Executable plans require an existing canonical private owner directory.");
  }
  const handle = await fs.open(
    output,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(recipe)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
