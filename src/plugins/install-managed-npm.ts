import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "../infra/install-package-dir.js";
import {
  buildNpmResolutionFields,
  formatNpmCommandFailureOutput,
  withInstallWorkspace,
  type NpmIntegrityDrift,
  type NpmSpecResolution,
} from "../infra/install-source-utils.js";
import {
  listMissingRequiredPlatformPackages,
  readManagedNpmRootInstalledDependency,
  readOpenClawManagedNpmRootOverrides,
  repairManagedNpmRootOpenClawPeer,
  syncManagedNpmRootPeerDependencies,
  upsertManagedNpmRootDependency,
  type ManagedNpmRootInstalledDependency,
} from "../infra/npm-managed-root.js";
import {
  createSafeNpmInstallArgs,
  createSafeNpmInstallEnv,
} from "../infra/safe-package-install.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";
import { installPluginFromInstalledPackageDir } from "./install-installed-package.js";
import {
  formatManagedNpmProjectQuarantineArtifacts,
  isManagedNpmProjectCorruptionInstallFailure,
  isNpmAliasOverrideCompatibilityError,
  listManagedNpmRootPackageNames,
  listNewManagedNpmRootPackageDirs,
  quarantineManagedNpmProjectRebuildArtifacts,
  resolveManagedNpmGenerationUseForInstall,
  resolveManagedNpmInstallRoot,
  resolveManagedNpmRootDependencySpecForInstall,
  resolveManagedNpmRootPackageDir,
  resolveRequiredPlatformPackageNames,
  shouldCopyManagedNpmProjectEntry,
  type ManagedNpmProjectQuarantine,
  type ManagedNpmRootDependencySpecPreparation,
  type ManagedNpmRootPreparedDependency,
} from "./install-managed-npm-state.js";
import { verifyInstalledNpmResolution } from "./install-npm-resolution.js";
import { resolveDefaultPluginNpmDir } from "./install-paths.js";
import {
  preflightPluginNpmInstallPolicy,
  type InstallSafetyOverrides,
} from "./install-security-scan.js";
import {
  defaultLogger,
  ensureInstallTargetAvailableForMode,
  formatUnresolvedOpenClawPeerLinkError,
  loadPluginInstallRuntime,
  readOptionalPackageManifest,
  resolveEffectiveInstallMode,
  runInstallSourceScan,
  sourceFamilyForInstallPolicySource,
} from "./install-shared.js";
import {
  attachPluginInstallTransaction,
  resolvePluginInstallTransactionRequest,
} from "./install-transaction.js";
import type {
  InstallPluginResult,
  PluginInstallArtifactConsentHandler,
  PluginInstallLogger,
  PluginInstallPolicyRequest,
} from "./install-types.js";
import { hasRetainedManagedNpmInstallMarker } from "./managed-npm-retention.js";
import { isOfficialCatalogLookupPluginIdReplacement } from "./official-external-install-records.js";
import {
  auditDeclaredOpenClawHostDependency,
  relinkOpenClawPeerDependenciesInManagedNpmRoot,
} from "./plugin-peer-link.js";

export async function installPluginFromManagedNpmRoot(
  params: InstallSafetyOverrides & {
    packageName: string;
    dependencySpec?: string;
    prepareDependencySpec?: ManagedNpmRootDependencySpecPreparation;
    displaySpec: string;
    installPolicyRequest: PluginInstallPolicyRequest;
    npmResolution: NpmSpecResolution;
    policyPreflightSourcePath?: string;
    policyPreflightSourcePathKind?: "file" | "directory";
    skipPolicyPreflight?: boolean;
    extensionsDir?: string;
    npmDir?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    logger?: PluginInstallLogger;
    mode?: "install" | "update";
    dryRun?: boolean;
    expectedPluginId?: string;
    expectedReplacementPluginId?: string;
    integrityDrift?: NpmIntegrityDrift;
    onBeforePluginArtifactCommit?: PluginInstallArtifactConsentHandler;
    beforePersistentApply?: () => void;
  },
): Promise<InstallPluginResult> {
  const transactionRequest = resolvePluginInstallTransactionRequest(params);
  const assertOwned = transactionRequest?.assertOwned;
  const signal = params.signal;
  const beforePersistentApply = params.beforePersistentApply;
  const runtime = await loadPluginInstallRuntime();
  const { logger, timeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(
    params,
    defaultLogger,
  );
  const expectedPluginId = params.expectedPluginId;
  const npmBaseDir = params.npmDir ? resolveUserPath(params.npmDir) : resolveDefaultPluginNpmDir();
  const generationUse = await resolveManagedNpmGenerationUseForInstall({
    runtime,
    npmBaseDir,
    packageName: params.packageName,
    requestedMode: mode,
    npmResolution: params.npmResolution,
  });
  const targetNpmRoot = resolveManagedNpmInstallRoot({
    npmBaseDir,
    packageName: params.packageName,
    npmResolution: params.npmResolution,
    useGeneration: generationUse !== "none",
  });
  const targetInstallRoot = resolveManagedNpmRootPackageDir(targetNpmRoot, params.packageName);
  const targetMode =
    generationUse === "retained-install" && hasRetainedManagedNpmInstallMarker(targetInstallRoot)
      ? "update"
      : await resolveEffectiveInstallMode({
          runtime,
          requestedMode: mode,
          targetPath: targetInstallRoot,
        });
  const policyMode =
    generationUse === "update"
      ? "update"
      : generationUse === "retained-install"
        ? "install"
        : targetMode;
  const availability = await ensureInstallTargetAvailableForMode({
    runtime,
    targetPath: targetInstallRoot,
    mode: targetMode,
  });
  if (!availability.ok) {
    return availability;
  }

  if (!params.skipPolicyPreflight) {
    const preflightPolicyResult = await runInstallSourceScan({
      subject: `Plugin "${expectedPluginId ?? params.packageName}"`,
      pluginId: expectedPluginId ?? params.packageName,
      mode: policyMode,
      sourceFamily: sourceFamilyForInstallPolicySource(params.installPolicyRequest.source, "npm"),
      scan: async () =>
        await preflightPluginNpmInstallPolicy({
          config: params.config,
          dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
          onInstallPolicyWarning: params.onInstallPolicyWarning,
          logger,
          mode: policyMode,
          packageName: params.packageName,
          ...(expectedPluginId ? { pluginId: expectedPluginId } : {}),
          requestedSpecifier: params.installPolicyRequest.requestedSpecifier ?? params.displaySpec,
          source: params.installPolicyRequest.source,
          sourcePath: params.policyPreflightSourcePath ?? targetNpmRoot,
          sourcePathKind: params.policyPreflightSourcePathKind ?? "directory",
        }),
    });
    if (preflightPolicyResult) {
      return preflightPolicyResult;
    }
  }

  if (dryRun) {
    return {
      ok: true,
      pluginId: expectedPluginId ?? params.packageName,
      targetDir: targetInstallRoot,
      extensions: [],
      npmResolution: params.npmResolution,
      ...(params.integrityDrift ? { integrityDrift: params.integrityDrift } : {}),
    };
  }
  params.signal?.throwIfAborted();

  let recovery:
    | {
        cause: { kind: "npm-corruption" | "incomplete-metadata"; error: string };
        quarantine: ManagedNpmProjectQuarantine;
      }
    | undefined;

  const runManagedNpmInstall = async (
    npmRoot: string,
    prepared: ManagedNpmRootPreparedDependency,
  ): Promise<InstallPluginResult> => {
    const installRoot = resolveManagedNpmRootPackageDir(npmRoot, params.packageName);
    logger.info?.(`Installing ${params.displaySpec} into ${targetNpmRoot}…`);
    if (params.packageName !== "openclaw") {
      const repairedOpenClawPeer = await repairManagedNpmRootOpenClawPeer({
        npmRoot,
        timeoutMs,
        signal: params.signal,
        logger,
      });
      if (repairedOpenClawPeer) {
        logger.info?.(`Repaired stale openclaw peer dependency in ${npmRoot}`);
      }
    }
    const managedOverrides = await readOpenClawManagedNpmRootOverrides();
    const quarantineForRecovery = async (
      cause: NonNullable<typeof recovery>["cause"],
    ): Promise<Extract<InstallPluginResult, { ok: false }> | null> => {
      try {
        const quarantine = await quarantineManagedNpmProjectRebuildArtifacts({
          npmRoot,
          recoveryRoot: path.dirname(targetNpmRoot),
        });
        recovery = { cause, quarantine };
      } catch (error) {
        return {
          ok: false,
          error: `${cause.error}, but OpenClaw could not quarantine ${npmRoot} for rebuild: ${String(error)}`,
        };
      }
      logger.warn?.(
        `${cause.error}; quarantined ${formatManagedNpmProjectQuarantineArtifacts(recovery.quarantine.movedArtifactNames)} at ${recovery.quarantine.quarantineDir} and rebuilding once before retrying.`,
      );
      return null;
    };
    let omitNpmAliasOverrides = false;
    const syncManagedPeerDependenciesForInstall = async (): Promise<
      { ok: true; changed: boolean } | { ok: false; error: string }
    > => {
      try {
        return {
          ok: true,
          changed: await syncManagedNpmRootPeerDependencies({
            npmRoot,
            managedOverrides,
            omitNpmAliasOverrides,
            timeoutMs,
            signal: params.signal,
          }),
        };
      } catch (error) {
        return {
          ok: false,
          error: `npm peer dependency planning failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    };
    const preInstallRootPackageNames = await listManagedNpmRootPackageNames(npmRoot);
    await upsertManagedNpmRootDependency({
      npmRoot,
      packageName: params.packageName,
      dependencySpec: prepared.dependencySpec,
      managedOverrides,
      omitNpmAliasOverrides,
    });
    const initialPeerSync = await syncManagedPeerDependenciesForInstall();
    if (!initialPeerSync.ok) {
      return { ok: false, error: initialPeerSync.error };
    }
    const npmInstallArgs = [
      "npm",
      ...createSafeNpmInstallArgs({
        omitDev: true,
        omitPeer: true,
        loglevel: "error",
        legacyPeerDeps: true,
        noAudit: true,
        noFund: true,
      }),
    ];
    const npmInstallOptions = {
      cwd: npmRoot,
      timeoutMs: Math.max(timeoutMs, 300_000),
      signal: params.signal,
      killProcessTree: true,
      env: createSafeNpmInstallEnv(process.env, {
        legacyPeerDeps: true,
        npmConfigCwd: npmRoot,
        packageLock: true,
        quiet: true,
      }),
    };
    let install = await runCommandWithTimeout(npmInstallArgs, npmInstallOptions);
    if (install.code !== 0 && isNpmAliasOverrideCompatibilityError(install)) {
      logger.warn?.(
        "npm rejected managed npm overrides; retrying plugin install without npm-incompatible overrides for this npm version.",
      );
      omitNpmAliasOverrides = true;
      await upsertManagedNpmRootDependency({
        npmRoot,
        packageName: params.packageName,
        dependencySpec: prepared.dependencySpec,
        managedOverrides,
        omitNpmAliasOverrides,
      });
      const aliasRetryPeerSync = await syncManagedPeerDependenciesForInstall();
      if (!aliasRetryPeerSync.ok) {
        return {
          ok: false,
          error: aliasRetryPeerSync.error,
        };
      }
      install = await runCommandWithTimeout(npmInstallArgs, npmInstallOptions);
    }
    if (!recovery && install.code !== 0 && isManagedNpmProjectCorruptionInstallFailure(install)) {
      const originalError = formatNpmCommandFailureOutput(install);
      const recoveryFailure = await quarantineForRecovery({
        kind: "npm-corruption",
        error: `npm install failed with a managed npm project corruption signature. Original npm error: ${originalError}`,
      });
      if (recoveryFailure) {
        return recoveryFailure;
      }
      return await runManagedNpmInstall(npmRoot, prepared);
    }
    if (install.code !== 0) {
      const error = recovery
        ? `npm install failed after managed npm project recovery (quarantine: ${recovery.quarantine.quarantineDir}): ${formatNpmCommandFailureOutput(install)}. Original ${recovery.cause.kind === "npm-corruption" ? "npm" : "verification"} error: ${recovery.cause.error}`
        : `npm install failed: ${formatNpmCommandFailureOutput(install)}`;
      return {
        ok: false,
        error,
      };
    }
    let settledManagedPeerDependencies = false;
    for (let peerSyncPass = 0; peerSyncPass < 10; peerSyncPass += 1) {
      const peerSync = await syncManagedPeerDependenciesForInstall();
      if (!peerSync.ok) {
        return { ok: false, error: peerSync.error };
      }
      const syncedPeerDependencies = peerSync.changed;
      if (!syncedPeerDependencies) {
        settledManagedPeerDependencies = true;
        break;
      }
      install = await runCommandWithTimeout(npmInstallArgs, npmInstallOptions);
      if (install.code !== 0) {
        return {
          ok: false,
          error: `npm install failed after syncing managed peer dependencies: ${formatNpmCommandFailureOutput(install)}`,
        };
      }
    }
    if (!settledManagedPeerDependencies) {
      const peerSync = await syncManagedPeerDependenciesForInstall();
      if (!peerSync.ok) {
        return { ok: false, error: peerSync.error };
      }
      settledManagedPeerDependencies = !peerSync.changed;
    }
    if (!settledManagedPeerDependencies) {
      return {
        ok: false,
        error:
          "npm install could not settle managed peer dependencies after 10 sync passes; refusing to leave a partially reconciled plugin dependency tree.",
      };
    }
    const packageManifestResult = await readOptionalPackageManifest({
      runtime,
      packageDir: installRoot,
    });
    if (!packageManifestResult.ok) {
      return packageManifestResult;
    }
    const requiredPlatformPackageNames = resolveRequiredPlatformPackageNames(
      packageManifestResult.manifest
        ? runtime.getPackageManifestMetadata(packageManifestResult.manifest)
        : undefined,
    );
    if (!requiredPlatformPackageNames.ok) {
      return {
        ok: false,
        error: requiredPlatformPackageNames.error,
      };
    }
    let incompletePlatformPackages: Awaited<ReturnType<typeof listMissingRequiredPlatformPackages>>;
    try {
      incompletePlatformPackages = await listMissingRequiredPlatformPackages({
        npmRoot,
        requiredPackageNames: requiredPlatformPackageNames.packageNames,
      });
    } catch (error) {
      return {
        ok: false,
        error: `Failed to verify platform-specific npm dependencies for ${params.packageName}: ${String(error)}`,
      };
    }
    if (incompletePlatformPackages.length > 0) {
      const incompletePlatformPackageNames = incompletePlatformPackages.map((entry) => entry.name);
      logger.warn?.(
        `npm left current-platform package(s) ${incompletePlatformPackageNames.join(", ")} missing or incomplete; retrying once with a fresh cache.`,
      );
      let freshCacheDir: string | undefined;
      try {
        await Promise.all(
          incompletePlatformPackages.map(({ packagePath }) =>
            fs.rm(packagePath, { recursive: true, force: true }),
          ),
        );
        freshCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-npm-cache-"));
        install = await runCommandWithTimeout(npmInstallArgs, {
          ...npmInstallOptions,
          env: {
            ...npmInstallOptions.env,
            NPM_CONFIG_CACHE: freshCacheDir,
            npm_config_cache: freshCacheDir,
          },
        });
      } catch (error) {
        return {
          ok: false,
          error: `Failed to repair missing or incomplete current-platform package(s) ${incompletePlatformPackageNames.join(", ")}: ${String(error)}`,
        };
      } finally {
        if (freshCacheDir) {
          try {
            await fs.rm(freshCacheDir, { recursive: true, force: true });
          } catch (error) {
            logger.warn?.(
              `Failed to remove temporary npm cache ${freshCacheDir}: ${String(error)}`,
            );
          }
        }
      }
      if (install.code !== 0) {
        return {
          ok: false,
          error: `npm install failed while repairing missing or incomplete current-platform package(s) ${incompletePlatformPackageNames.join(", ")}: ${formatNpmCommandFailureOutput(install)}`,
        };
      }
      let stillIncompletePlatformPackages: typeof incompletePlatformPackages;
      try {
        stillIncompletePlatformPackages = await listMissingRequiredPlatformPackages({
          npmRoot,
          requiredPackageNames: requiredPlatformPackageNames.packageNames,
        });
      } catch (error) {
        return {
          ok: false,
          error: `Failed to verify repaired platform-specific npm dependencies for ${params.packageName}: ${String(error)}`,
        };
      }
      if (stillIncompletePlatformPackages.length > 0) {
        return {
          ok: false,
          error: `npm install reported success but left required current-platform package(s) missing or incomplete: ${stillIncompletePlatformPackages.map((entry) => entry.name).join(", ")}`,
        };
      }
    }
    if (params.packageName !== "openclaw") {
      const repairedOpenClawPeer = await repairManagedNpmRootOpenClawPeer({
        npmRoot,
        timeoutMs,
        signal: params.signal,
        logger,
      });
      if (repairedOpenClawPeer) {
        logger.info?.(`Repaired stale openclaw peer dependency in ${npmRoot} after npm install`);
      }
    }
    try {
      await relinkOpenClawPeerDependenciesInManagedNpmRoot({
        npmRoot,
        logger,
      });
    } catch (error) {
      return {
        ok: false,
        error: `Failed to repair openclaw peer links after npm install: ${String(error)}`,
      };
    }
    if (await auditDeclaredOpenClawHostDependency({ packageDir: installRoot })) {
      return {
        ok: false,
        error: formatUnresolvedOpenClawPeerLinkError(params.packageName),
      };
    }

    let installedDependency: ManagedNpmRootInstalledDependency | null;
    try {
      installedDependency = await readManagedNpmRootInstalledDependency({
        npmRoot,
        packageName: params.packageName,
      });
    } catch (error) {
      return {
        ok: false,
        error: `Failed to verify npm install metadata for ${params.packageName}: ${String(error)}`,
      };
    }
    const resolutionVerification = verifyInstalledNpmResolution({
      packageName: params.packageName,
      expected: params.npmResolution,
      installed: installedDependency,
    });
    if (resolutionVerification.kind === "conflict") {
      return {
        ok: false,
        error: resolutionVerification.error,
      };
    }
    if (resolutionVerification.kind === "incomplete") {
      if (!recovery) {
        const recoveryFailure = await quarantineForRecovery({
          kind: "incomplete-metadata",
          error: resolutionVerification.error,
        });
        if (recoveryFailure) {
          return recoveryFailure;
        }
        return await runManagedNpmInstall(npmRoot, prepared);
      }
      return {
        ok: false,
        error: `npm install metadata remained incomplete after managed npm project recovery (quarantine: ${recovery.quarantine.quarantineDir}): ${resolutionVerification.error}`,
      };
    }

    const newRootPackageDirs = await listNewManagedNpmRootPackageDirs({
      beforeInstallPackageNames: preInstallRootPackageNames,
      npmRoot,
    });
    let installedExpectedPluginId = expectedPluginId;
    if (
      mode === "update" &&
      params.trustedSourceLinkedOfficialInstall === true &&
      expectedPluginId &&
      params.expectedReplacementPluginId
    ) {
      const manifestResult = runtime.loadPluginManifest(installRoot);
      if (
        manifestResult.ok &&
        manifestResult.manifest.id === params.expectedReplacementPluginId &&
        (manifestResult.manifest.legacyPluginIds?.includes(expectedPluginId) ||
          isOfficialCatalogLookupPluginIdReplacement({
            expectedPluginId,
            expectedReplacementPluginId: params.expectedReplacementPluginId,
          }))
      ) {
        // Only managed npm updates may replace an expected id, after the downloaded
        // official manifest corroborates the catalog-declared migration.
        installedExpectedPluginId = params.expectedReplacementPluginId;
      }
    }
    const result = await installPluginFromInstalledPackageDir({
      dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
      onInstallPolicyWarning: params.onInstallPolicyWarning,
      config: params.config,
      additionalDependencyPackageDirs: newRootPackageDirs,
      packageDir: installRoot,
      dependencyScanRootDir: npmRoot,
      logger,
      expectedPluginId: installedExpectedPluginId,
      requirePluginManifest: params.trustedSourceLinkedOfficialInstall,
      trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
      mode: policyMode,
      installPolicyRequest: params.installPolicyRequest,
      emitSuccessSecurityEvent: false,
    });
    if (!result.ok) {
      return result;
    }
    await params.onBeforePluginArtifactCommit?.({
      pluginId: result.pluginId,
      ...(policyMode === "update" ? { currentArtifactDir: targetInstallRoot } : {}),
      stagedArtifactDir: installRoot,
      mode: policyMode,
      ...(params.installPolicyRequest.source?.kind === "npm"
        ? {
            sourceRecord: {
              source: "npm" as const,
              spec: params.displaySpec,
              ...buildNpmResolutionFields(params.npmResolution),
            },
          }
        : {}),
    });
    return {
      ...result,
      targetDir: targetInstallRoot,
      npmResolution: params.npmResolution,
      ...(params.integrityDrift ? { integrityDrift: params.integrityDrift } : {}),
    };
  };

  return await withInstallWorkspace("openclaw-npm-project-", async (emptySourceDir) => {
    const projectExists = await runtime.fileExists(targetNpmRoot);
    let stagingFailure: { error: unknown } | undefined;
    const publishParams = {
      sourceDir: projectExists ? targetNpmRoot : emptySourceDir,
      targetDir: targetNpmRoot,
      mode: projectExists ? ("update" as const) : ("install" as const),
      timeoutMs,
      logger,
      copyErrorPrefix: "Failed to install managed npm project",
      hasDeps: false,
      sourceHardlinks: "package-manager" as const,
      copyFilter: (sourcePath: string) =>
        shouldCopyManagedNpmProjectEntry({
          nodeModulesDir: path.join(targetNpmRoot, "node_modules"),
          sourcePath,
        }),
      depsLogMessage: "Installing plugin dependencies…",
      beforePersistentApply: () => {
        beforePersistentApply?.();
        signal?.throwIfAborted();
      },
      afterInstall: async (npmRoot: string): Promise<InstallPluginResult> => {
        const dependency = await resolveManagedNpmRootDependencySpecForInstall({
          npmRoot,
          packageName: params.packageName,
          dependencySpec: params.dependencySpec,
          prepareDependencySpec: params.prepareDependencySpec,
        });
        if (!dependency.ok) {
          return dependency;
        }
        try {
          return await runManagedNpmInstall(npmRoot, dependency);
        } catch (error) {
          // The directory publisher returns failures; preserve typed consent/authority errors.
          stagingFailure = { error };
          throw error;
        }
      },
    };
    const published = await runtime.installPackageDir(
      transactionRequest
        ? requestDeferredPackageDirInstall(publishParams, assertOwned)
        : publishParams,
    );
    if (!published.ok) {
      if (stagingFailure) {
        throw stagingFailure.error;
      }
      return published;
    }
    const transaction = resolvePackageDirInstallTransaction(published);
    return transaction ? attachPluginInstallTransaction(published, transaction) : published;
  });
}
