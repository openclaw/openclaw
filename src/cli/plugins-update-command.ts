import { isDeepStrictEqual } from "node:util";
import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  getRuntimeConfig,
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
} from "../config/config.js";
import { containsConfigIncludeDirective } from "../config/io.read-helpers.js";
import { createMergePatch, applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { readHookInstalls } from "../hooks/installs.js";
import { updateNpmInstalledHookPacks } from "../hooks/update.js";
import { normalizeUpdateChannel, resolveRegistryUpdateChannel } from "../infra/update-channels.js";
import { resolveSourceCheckoutBundledPluginIds } from "../plugins/bundled-sources.js";
import {
  assertRecordsOnlyUpdateConfigFresh,
  resolveCombinedPluginAndHookConfigMutationPreflight,
  resolveInstallConfigMutationPreflights,
  selectInstallMutationWriteOptions,
} from "../plugins/install-config-mutation.js";
import {
  commitPluginInstallRecordsOnly,
  commitPluginInstallRecordsWithConfig,
  getRetainedPluginInstallPublication,
} from "../plugins/install-record-commit.js";
import {
  requestDeferredPluginInstall,
  resolvePluginInstallOwnerMigrations,
  settlePluginInstallTransactions,
  type PluginInstallTransaction,
} from "../plugins/install-transaction.js";
import {
  loadInstalledPluginIndexInstallRecords,
  withoutPluginInstallRecords,
  withPluginInstallRecords,
} from "../plugins/installed-plugin-index-records.js";
import { loadInstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { createInstalledPluginOwnershipResolver } from "../plugins/installed-plugin-package-ownership.js";
import { configReferencesNpmInstallPath } from "../plugins/installs.js";
import { VERSION_BOUND_RUNTIME_PLUGIN_IDS } from "../plugins/official-runtime-plugins.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import {
  withPluginLifecycleLease,
  type PluginLifecycleLeaseContext,
} from "../plugins/plugin-lifecycle-lease.js";
import {
  capturePluginPackageUpdateSnapshot,
  pluginPackageUpdateMayMutateConfig,
  reconcilePluginPackageUpdateConfig,
} from "../plugins/plugin-package-update.js";
import { resolveOfficialPluginCohortNpmSpecs } from "../plugins/plugin-version-drift.js";
import { refreshPluginRegistryAfterConfigMutation } from "../plugins/registry-refresh.js";
import {
  isClawHubTrustSkippedOutcome,
  isPluginInstallRecordUpdateSource,
  pluginInstallRecordMayMigrateConfigId,
  updateNpmInstalledPlugins,
  type PluginUpdateIntegrityDriftParams,
  type PluginUpdateOutcome,
} from "../plugins/update.js";
import { defaultRuntime } from "../runtime.js";
import { VERSION } from "../version.js";
import { formatCliCommand } from "./command-format.js";
import { resolveInstallPolicyWarningAcknowledgementCliOptions } from "./install-policy-warning-acknowledgement.js";
import { resolvePluginCapabilityConsentCliOptions } from "./plugin-capability-consent.js";
import { createPluginInstallLogger } from "./plugins-command-helpers.js";
import { runWithLocalPluginState } from "./plugins-local-state.js";
import {
  resolveHookPackUpdateSelection,
  resolvePluginUpdateSelection,
} from "./plugins-update-selection.js";
import { promptYesNo } from "./prompt.js";

const DEPRECATED_DANGEROUS_FORCE_UNSAFE_UPDATE_WARNING =
  "--dangerously-force-unsafe-install is deprecated and no longer affects plugin updates because built-in install-time dangerous-code scanning has been removed. Configure security.installPolicy for operator-owned install decisions.";

function logPluginUpdateOutcomes(
  outcomes: readonly Pick<PluginUpdateOutcome, "status" | "message" | "channelFallback" | "code">[],
): 0 | 1 {
  let exitCode: 0 | 1 = 0;
  for (const outcome of outcomes) {
    if (outcome.status === "error") {
      exitCode = 1;
      defaultRuntime.error(theme.error(outcome.message));
    } else if (outcome.status === "skipped") {
      if (isClawHubTrustSkippedOutcome(outcome)) {
        exitCode = 1;
      }
      defaultRuntime.log(theme.warn(outcome.message));
    } else {
      defaultRuntime.log(outcome.message);
    }
    if (outcome.channelFallback) {
      defaultRuntime.log(theme.warn(outcome.channelFallback.message));
    }
  }
  return exitCode;
}

async function confirmUpdateIntegrityDrift(
  item: string,
  drift: Omit<PluginUpdateIntegrityDriftParams, "pluginId">,
): Promise<boolean> {
  defaultRuntime.log(
    theme.warn(
      `Integrity drift detected for ${item} (${drift.resolvedSpec ?? drift.spec})` +
        `\nExpected: ${drift.expectedIntegrity}` +
        `\nActual:   ${drift.actualIntegrity}`,
    ),
  );
  return drift.dryRun || (await promptYesNo(`Continue updating ${item} with this artifact?`));
}

function mayMutatePluginInstallRecord(
  record: PluginInstallRecord | undefined,
  specOverride: string | undefined,
): boolean {
  if (!isPluginInstallRecordUpdateSource(record)) {
    return false;
  }
  if (record?.source === "npm") {
    return Boolean(specOverride ?? record.spec);
  }
  if (record?.source === "git") {
    return Boolean(record.spec);
  }
  if (record?.source === "clawhub") {
    return Boolean(record.clawhubPackage);
  }
  return Boolean(record?.marketplaceSource && record.marketplacePlugin);
}

function pluginConfigReferencesId(config: ReturnType<typeof getRuntimeConfig>, pluginId: string) {
  const plugins = config.plugins;
  return (
    plugins?.allow?.includes(pluginId) ||
    plugins?.deny?.includes(pluginId) ||
    Object.hasOwn(plugins?.entries ?? {}, pluginId) ||
    plugins?.slots?.memory === pluginId ||
    plugins?.slots?.contextEngine === pluginId
  );
}

function shouldPreserveEmptyPlugins(params: {
  parsed: unknown;
  sourceConfig: ReturnType<typeof getRuntimeConfig>;
}): boolean {
  const plugins = params.sourceConfig.plugins;
  const parsedPlugins =
    params.parsed && typeof params.parsed === "object" && !Array.isArray(params.parsed)
      ? (params.parsed as Record<string, unknown>).plugins
      : undefined;
  return Boolean(
    plugins &&
    (!Object.hasOwn(plugins, "installs") ||
      Object.keys(plugins).some((key) => key !== "installs") ||
      containsConfigIncludeDirective(parsedPlugins)),
  );
}

export type RunPluginUpdateCommandParams = {
  ids: string[];
  opts: {
    all?: boolean;
    acceptCapabilities?: boolean;
    acknowledgeInstallPolicyWarning?: boolean;
    dryRun?: boolean;
    dangerouslyForceUnsafeInstall?: boolean;
  };
};

/** Run offline plugin/hook-pack updates and persist state for the next Gateway start. */
export async function runPluginUpdateCommand(params: RunPluginUpdateCommandParams) {
  if (params.opts.all && params.ids.length > 0) {
    defaultRuntime.error("Use either plugin or hook-pack ids or --all, not both.");
    defaultRuntime.exit(1);
    return;
  }
  if (params.opts.dryRun) {
    const exitCode = await runPluginUpdateCommandUnlocked(params);
    if (exitCode !== 0) {
      defaultRuntime.exit(exitCode);
    }
    return;
  }
  assertConfigWriteAllowedInCurrentMode();
  let changed = false;
  let activationDeferred = false;
  const exitCode = await runWithLocalPluginState("update", (assertCurrent) =>
    withPluginLifecycleLease({}, (lease) =>
      runPluginUpdateCommandUnlocked(
        params,
        lease,
        (deferred) => {
          changed = true;
          activationDeferred ||= deferred;
        },
        assertCurrent,
      ),
    ),
  );
  if (changed && !activationDeferred) {
    defaultRuntime.log("Updates saved; they will load on the next Gateway start.");
  }
  if (exitCode !== 0) {
    defaultRuntime.exit(exitCode);
  }
}

async function runPluginUpdateCommandUnlocked(
  params: RunPluginUpdateCommandParams,
  lease?: PluginLifecycleLeaseContext,
  onMetadataChanged?: (activationDeferred: boolean) => void,
  assertCurrent?: () => void,
): Promise<0 | 1> {
  const assertOwned = () => {
    assertCurrent?.();
    lease?.assertOwned();
  };
  if (!params.opts.dryRun) {
    assertConfigWriteAllowedInCurrentMode();
  }

  const sourceSnapshotPromise = readConfigFileSnapshotForWrite()
    .then((prepared) => {
      const writeOptions = selectInstallMutationWriteOptions(prepared.writeOptions);
      return {
        ...prepared,
        writeOptions: {
          ...writeOptions,
          assertConfigPathForWrite: () => {
            assertOwned?.();
            writeOptions.assertConfigPathForWrite?.();
          },
        },
      };
    })
    .catch(() => null);
  const mutationSnapshot = params.opts.dryRun ? null : await sourceSnapshotPromise;
  if (!params.opts.dryRun && !mutationSnapshot) {
    defaultRuntime.error("Could not inspect config ownership before updating plugins or hooks.");
    return 1;
  }
  if (mutationSnapshot && !mutationSnapshot.snapshot.valid) {
    defaultRuntime.error("Cannot update plugins or hooks while the config is invalid.");
    return 1;
  }
  // Bind selection, updater input, ownership checks, and persistence to one
  // mutation-start snapshot so concurrent config changes cannot be resurrected.
  const cfg = mutationSnapshot?.snapshot.runtimeConfig ?? getRuntimeConfig();
  const sourceCfg = mutationSnapshot?.snapshot.sourceConfig ?? cfg;
  const pluginInstallRecords = await loadInstalledPluginIndexInstallRecords();
  const cfgWithPluginInstallRecords = withPluginInstallRecords(cfg, pluginInstallRecords);
  const sourceCfgWithPluginInstallRecords = withPluginInstallRecords(
    sourceCfg,
    pluginInstallRecords,
  );
  const installedPluginIndex = loadInstalledPluginIndex({
    config: cfgWithPluginInstallRecords,
    installRecords: pluginInstallRecords,
  });
  const sourceBundledIds = resolveSourceCheckoutBundledPluginIds({
    config: cfgWithPluginInstallRecords,
    installRecords: pluginInstallRecords,
  });
  const installOwnerByPluginId = new Map<string, string>();
  const rejectedPluginIds = new Map<string, string>();
  const ownershipResolver = createInstalledPluginOwnershipResolver(installedPluginIndex);
  for (const pluginId of new Set([
    ...installedPluginIndex.plugins.map((plugin) => plugin.pluginId),
    ...Object.keys(pluginInstallRecords),
  ])) {
    if (sourceBundledIds.has(pluginId)) {
      continue;
    }
    const ownership = ownershipResolver.resolveLifecycle(pluginId);
    if (!ownership.ok) {
      rejectedPluginIds.set(pluginId, ownership.error);
      continue;
    }
    installOwnerByPluginId.set(pluginId, ownership.value.installOwner);
    installOwnerByPluginId.set(ownership.value.installOwner, ownership.value.installOwner);
  }
  const configuredUpdateChannel = normalizeUpdateChannel(cfg.update?.channel) ?? undefined;
  const officialPluginUpdateChannel = resolveRegistryUpdateChannel({
    configChannel: configuredUpdateChannel,
    currentVersion: VERSION,
  });
  const logger = createPluginInstallLogger();
  if (params.opts.dangerouslyForceUnsafeInstall) {
    defaultRuntime.log(theme.warn(DEPRECATED_DANGEROUS_FORCE_UNSAFE_UPDATE_WARNING));
  }
  const pluginSelection = resolvePluginUpdateSelection({
    installs: pluginInstallRecords,
    installOwnerByPluginId,
    rejectedPluginIds,
    rawIds: params.ids,
    all: params.opts.all,
  });
  if (pluginSelection.error) {
    defaultRuntime.error(pluginSelection.error);
    return 1;
  }
  const selectedHooks = readHookInstalls();
  const hookSelection = resolveHookPackUpdateSelection({
    installs: selectedHooks,
    rawIds: params.ids,
    all: params.opts.all,
  });
  if (hookSelection.error) {
    defaultRuntime.error(hookSelection.error);
    return 1;
  }
  const unmatchedId = pluginSelection.unmatchedIds?.find((id) =>
    hookSelection.unmatchedIds?.includes(id),
  );
  if (unmatchedId !== undefined) {
    defaultRuntime.error(
      `No tracked plugin or hook pack found for "${unmatchedId}". Run "${formatCliCommand("openclaw plugins list")}" or "${formatCliCommand("openclaw hooks list")}" to inspect installed packages.`,
    );
    return 1;
  }
  // Dormant records still reach the updater for notices, but no package mutation.
  const packageUpdateIds = pluginSelection.pluginIds.filter((id) => !sourceBundledIds.has(id));
  const packageUpdateSnapshotResult = capturePluginPackageUpdateSnapshot({
    index: installedPluginIndex,
    installOwners: packageUpdateIds,
  });
  if (!packageUpdateSnapshotResult.ok) {
    defaultRuntime.error(packageUpdateSnapshotResult.error);
    return 1;
  }
  const packageUpdateSnapshot = packageUpdateSnapshotResult.value;
  const packagePluginIds = Object.fromEntries(
    [...packageUpdateSnapshot.values()].map((ownership) => [
      ownership.installOwner,
      [...ownership.pluginIds],
    ]),
  );
  if (pluginSelection.pluginIds.length === 0 && hookSelection.hookIds.length === 0) {
    if (params.opts.all) {
      defaultRuntime.log("No tracked plugins or hook packs to update.");
      return 0;
    }
    defaultRuntime.error("Provide plugin or hook-pack ids, or use --all.");
    return 1;
  }

  const pluginUpdateMayMutate =
    !params.opts.dryRun &&
    packageUpdateIds.some((pluginId) => {
      return mayMutatePluginInstallRecord(
        pluginInstallRecords[pluginId],
        pluginSelection.specOverrides?.[pluginId],
      );
    });
  const hookUpdateMayMutate =
    !params.opts.dryRun &&
    hookSelection.hookIds.some((hookId) => {
      const record = selectedHooks[hookId];
      return (
        record?.source === "npm" && Boolean(hookSelection.specOverrides?.[hookId] ?? record.spec)
      );
    });
  if (pluginUpdateMayMutate || hookUpdateMayMutate) {
    if (!mutationSnapshot) {
      defaultRuntime.error("Could not inspect config ownership before updating plugins or hooks.");
      return 1;
    }
    const { hookMutation, pluginMutation } = resolveInstallConfigMutationPreflights({
      parsed: (mutationSnapshot.snapshot.parsed ?? {}) as Record<string, unknown>,
      snapshotPath: mutationSnapshot.snapshot.path,
      writeOptions: mutationSnapshot.writeOptions,
    });
    const parsedConfig =
      mutationSnapshot.snapshot.parsed &&
      typeof mutationSnapshot.snapshot.parsed === "object" &&
      !Array.isArray(mutationSnapshot.snapshot.parsed)
        ? (mutationSnapshot.snapshot.parsed as Record<string, unknown>)
        : {};
    const pluginReferencesMayBeUnresolved =
      Object.hasOwn(parsedConfig, "$include") ||
      containsConfigIncludeDirective(mutationSnapshot.snapshot.sourceConfig.plugins);
    const pluginIdMigrationMayMutate = packageUpdateIds.some((pluginId) => {
      return (
        pluginInstallRecordMayMigrateConfigId({
          pluginId,
          record: pluginInstallRecords[pluginId],
          specOverride: pluginSelection.specOverrides?.[pluginId],
        }) &&
        (pluginReferencesMayBeUnresolved ||
          pluginConfigReferencesId(mutationSnapshot.snapshot.sourceConfig, pluginId))
      );
    });
    const pluginLoadPathMayMutate = packageUpdateIds.some((pluginId) =>
      configReferencesNpmInstallPath({
        config: cfg,
        install: pluginInstallRecords[pluginId],
      }),
    );
    // Manual update records stay in the index unless scoped-package compatibility
    // migrates authored references or moves an explicit prior managed root.
    const pluginConfigMayMutate =
      pluginIdMigrationMayMutate ||
      pluginLoadPathMayMutate ||
      pluginPackageUpdateMayMutateConfig({
        config: mutationSnapshot.snapshot.sourceConfig,
        index: installedPluginIndex,
        snapshot: packageUpdateSnapshot,
      });
    const blockedReasons = new Set<string>();
    if (pluginConfigMayMutate && pluginMutation.mode === "blocked") {
      blockedReasons.add(pluginMutation.reason);
    }
    if (hookUpdateMayMutate && hookMutation.mode === "blocked") {
      blockedReasons.add(hookMutation.reason);
    }
    if (
      pluginConfigMayMutate &&
      hookUpdateMayMutate &&
      pluginMutation.mode === "allowed" &&
      hookMutation.mode === "allowed"
    ) {
      // Config persistence can commit one include-owned top-level section, not
      // a mixed plugin-and-hook mutation spanning root and include ownership.
      const combinedMutation = resolveCombinedPluginAndHookConfigMutationPreflight({
        parsed: (mutationSnapshot.snapshot.parsed ?? {}) as Record<string, unknown>,
        snapshotPath: mutationSnapshot.snapshot.path,
      });
      if (combinedMutation.mode === "blocked") {
        blockedReasons.add(combinedMutation.reason);
      }
    }
    if (blockedReasons.size > 0) {
      defaultRuntime.error(Array.from(blockedReasons).join(" "));
      return 1;
    }
  }

  const installPolicyWarningAcknowledgement = resolveInstallPolicyWarningAcknowledgementCliOptions({
    acknowledgeInstallPolicyWarning: params.opts.acknowledgeInstallPolicyWarning,
    allowPrompt: !params.opts.dryRun,
  });
  const deferredInstallTransactions: PluginInstallTransaction[] = [];
  let packageUpdatePersisted = false;
  let updateFailure: { error: unknown } | undefined;
  try {
    let pluginResult =
      pluginSelection.pluginIds.length > 0
        ? await updateNpmInstalledPlugins(
            requestDeferredPluginInstall(
              {
                config: cfgWithPluginInstallRecords,
                pluginIds: pluginSelection.pluginIds,
                packagePluginIds,
                specOverrides: pluginSelection.specOverrides,
                dryRun: params.opts.dryRun,
                updateChannel: params.opts.all ? undefined : configuredUpdateChannel,
                officialPluginUpdateChannel,
                syncOfficialPluginInstalls: params.opts.all ? true : undefined,
                coreVersion: VERSION,
                versionBoundPluginIds: VERSION_BOUND_RUNTIME_PLUGIN_IDS,
                npmInstallSpecOverrides: resolveOfficialPluginCohortNpmSpecs({
                  gatewayVersion: VERSION,
                  installRecords: pluginInstallRecords,
                  config: cfgWithPluginInstallRecords,
                }),
                ...installPolicyWarningAcknowledgement,
                ...resolvePluginCapabilityConsentCliOptions({
                  acceptCapabilities: params.opts.acceptCapabilities,
                  action: "update",
                  allowPrompt: !params.opts.dryRun,
                }),
                logger,
                onIntegrityDrift: (drift) =>
                  confirmUpdateIntegrityDrift(`"${drift.pluginId}"`, drift),
              },
              deferredInstallTransactions,
              assertOwned,
            ),
          )
        : { config: cfgWithPluginInstallRecords, changed: false, outcomes: [] };
    if (pluginSelection.pluginIds.length > 0 && pluginResult.changed && !params.opts.dryRun) {
      const nextInstallRecords = pluginResult.config.plugins?.installs ?? {};
      // The installer may restore or replace bytes at a previously observed path.
      const afterIndex = withPluginCache(createPluginCache(), () =>
        loadInstalledPluginIndex({
          config: pluginResult.config,
          installRecords: nextInstallRecords,
        }),
      );
      const reconciled = reconcilePluginPackageUpdateConfig({
        config: pluginResult.config,
        beforeIndex: installedPluginIndex,
        afterIndex,
        snapshot: packageUpdateSnapshot,
        installOwnerMigrations: resolvePluginInstallOwnerMigrations(pluginResult),
      });
      if (!reconciled.ok) {
        defaultRuntime.error(reconciled.error);
        return 1;
      }
      pluginResult = { ...pluginResult, config: reconciled.config };
    }
    const hookResult =
      hookSelection.hookIds.length > 0
        ? await updateNpmInstalledHookPacks(
            requestDeferredPluginInstall(
              {
                config: pluginResult.config,
                lease,
                beforePersistentApply: mutationSnapshot?.writeOptions.assertConfigPathForWrite,
                hookIds: hookSelection.hookIds,
                specOverrides: hookSelection.specOverrides,
                dryRun: params.opts.dryRun,
                ...installPolicyWarningAcknowledgement,
                logger,
                onIntegrityDrift: (drift) =>
                  confirmUpdateIntegrityDrift(`hook pack "${drift.hookId}"`, drift),
              },
              deferredInstallTransactions,
              assertOwned,
            ),
          )
        : { config: pluginResult.config, changed: false, outcomes: [] };

    if (!params.opts.dryRun) {
      const sourceSnapshot = mutationSnapshot ?? (await sourceSnapshotPromise);
      if (pluginResult.changed) {
        const currentInstallRecords = await loadInstalledPluginIndexInstallRecords();
        const currentSnapshot = capturePluginPackageUpdateSnapshot({
          index: installedPluginIndex,
          installOwners: packageUpdateIds,
        });
        if (
          !isDeepStrictEqual(currentInstallRecords, pluginInstallRecords) ||
          !currentSnapshot.ok ||
          !isDeepStrictEqual([...currentSnapshot.value], [...packageUpdateSnapshot])
        ) {
          defaultRuntime.error(
            currentSnapshot.ok
              ? "Plugin package ownership changed during update; no config or index changes were committed. Refresh the plugin registry and retry."
              : currentSnapshot.error,
          );
          return 1;
        }
      }
      const nextPluginInstallRecords = pluginResult.config.plugins?.installs ?? {};
      const shouldPersistPluginInstallIndex =
        pluginResult.changed || Object.keys(pluginInstallRecords).length > 0;
      const sourceShapedUpdateConfig = applyMergePatch(
        sourceCfgWithPluginInstallRecords,
        createMergePatch(cfgWithPluginInstallRecords, hookResult.config),
      ) as OpenClawConfig;
      // Plugin install records live in the persisted index. Preserve an authored
      // empty plugins section so include ownership does not become a false mutation.
      let nextConfig = withoutPluginInstallRecords(sourceShapedUpdateConfig, {
        preserveEmptyPlugins: shouldPreserveEmptyPlugins({
          parsed: sourceSnapshot?.snapshot.parsed,
          sourceConfig: sourceSnapshot?.snapshot.sourceConfig ?? {},
        }),
      });
      const writeOptions = {
        ...sourceSnapshot?.writeOptions,
        afterWrite: {
          mode: "none" as const,
          reason: "plugin update owns registry refresh",
        },
      };
      const { preparePluginUpdateConfigMigration } =
        await import("../commands/doctor/shared/plugin-update-config-migration.js");
      const installOwnerMigrations = resolvePluginInstallOwnerMigrations(pluginResult);
      const migrationOwners = pluginResult.outcomes
        .filter((outcome) => outcome.status === "updated" || outcome.status === "unchanged")
        .map((outcome) => installOwnerMigrations?.[outcome.pluginId] ?? outcome.pluginId);
      await using migration =
        sourceSnapshot && migrationOwners.length > 0
          ? await preparePluginUpdateConfigMigration({
              config: nextConfig,
              snapshot: sourceSnapshot.snapshot,
              installRecords: nextPluginInstallRecords,
              installOwners: migrationOwners,
              assertCurrent: () => {
                assertOwned?.();
                sourceSnapshot.writeOptions.assertConfigPathForWrite?.();
              },
            })
          : undefined;
      if (!pluginResult.changed && !hookResult.changed && !migration?.changed) {
        await migration?.publish(nextConfig, async () => {});
        return logPluginUpdateOutcomes([...pluginResult.outcomes, ...hookResult.outcomes]);
      }
      nextConfig = migration?.config ?? nextConfig;
      const commit = async () => {
        if (shouldPersistPluginInstallIndex) {
          if (
            !migration?.changed &&
            isDeepStrictEqual(nextConfig, sourceSnapshot?.snapshot.sourceConfig ?? sourceCfg)
          ) {
            await commitPluginInstallRecordsOnly({
              previousInstallRecords: pluginInstallRecords,
              nextInstallRecords: nextPluginInstallRecords,
              nextConfig,
              verifyConfigFresh: async () => {
                await assertRecordsOnlyUpdateConfigFresh({
                  baseHash: sourceSnapshot?.snapshot.hash,
                  writeOptions: sourceSnapshot?.writeOptions,
                });
              },
            });
          } else {
            await commitPluginInstallRecordsWithConfig({
              previousInstallRecords: pluginInstallRecords,
              nextInstallRecords: nextPluginInstallRecords,
              nextConfig,
              baseHash: sourceSnapshot?.snapshot.hash,
              writeOptions,
            });
          }
        } else {
          await replaceConfigFile({
            nextConfig,
            baseHash: sourceSnapshot?.snapshot.hash,
            writeOptions,
          });
        }
      };
      await (migration ? migration.publish(nextConfig, commit) : commit());
      packageUpdatePersisted = true;
      onMetadataChanged?.(Boolean(migration?.activationWarning));
      if (migration?.activationWarning) {
        logger.warn(migration.activationWarning);
      }
      await settlePluginInstallTransactions(deferredInstallTransactions, "commit").catch(() =>
        logger.warn("Plugin update committed, but cleanup failed. Run openclaw plugins doctor."),
      );
      if (pluginResult.changed) {
        await refreshPluginRegistryAfterConfigMutation({
          configPath: sourceSnapshot?.writeOptions.ownedConfigPathForWrite,
          reason: "source-changed",
          installRecords: nextPluginInstallRecords,
          invalidateRuntimeCache: false,
          logger,
        });
      }
    }

    return logPluginUpdateOutcomes([...pluginResult.outcomes, ...hookResult.outcomes]);
  } catch (error) {
    updateFailure = { error };
    if (getRetainedPluginInstallPublication(error)) {
      packageUpdatePersisted = true;
      await settlePluginInstallTransactions(deferredInstallTransactions, "commit").catch(() =>
        logger.warn("Plugin update was retained, but cleanup failed. Run openclaw plugins doctor."),
      );
    }
    throw error;
  } finally {
    if (!packageUpdatePersisted) {
      await settlePluginInstallTransactions(deferredInstallTransactions, "rollback", updateFailure);
    }
  }
}
