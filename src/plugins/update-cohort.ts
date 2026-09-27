import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import { resolveSourceCheckoutBundledPluginIds } from "./bundled-sources.js";
import type { PluginCapabilityConsentHandler } from "./capability-consent.js";
import type { ExternalizedBundledPluginBridge } from "./externalized-bundled-plugins.js";
import {
  attachPluginInstallOwnerMigrations,
  resolvePluginInstallOwnerMigrations,
} from "./install-transaction.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { createInstalledPluginOwnershipResolver } from "./installed-plugin-package-ownership.js";
import {
  collectMissingPluginInstallPayloads,
  type MissingPluginInstallPayload,
} from "./payload-verification.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import {
  capturePluginPackageUpdateSnapshot,
  reconcilePluginPackageUpdateConfig,
} from "./plugin-package-update.js";
import { resolveOfficialPluginCohortNpmSpecs } from "./plugin-version-drift.js";
import type { PluginChannelSyncResult } from "./update-channel.js";
import {
  isPluginInstallRecordUpdateSource,
  type PluginUpdateIntegrityDriftParams,
  type PluginUpdateLogger,
  type PluginUpdateOutcome,
} from "./update-source.js";
import { syncPluginsForUpdateChannel, updateNpmInstalledPlugins } from "./update.js";

export type PluginCohortConvergenceResult = {
  config: OpenClawConfig;
  changed: boolean;
  npmChanged: boolean;
  sync: PluginChannelSyncResult;
  missingPayloads: MissingPluginInstallPayload[];
  repairedMissingPayloadIds: Set<string>;
  repairOutcomes: PluginUpdateOutcome[];
  updateOutcomes: PluginUpdateOutcome[];
  remainingMissingPayloads: MissingPluginInstallPayload[];
};

/** Aligns managed plugin install sources and official packages with one core release cohort. */
export async function convergePluginReleaseCohort(params: {
  config: OpenClawConfig;
  channel: UpdateChannel;
  coreVersion?: string;
  versionBoundPluginIds?: ReadonlySet<string>;
  timeoutMs: number;
  workTimeoutMs?: number | null;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  externalizedBundledPluginBridges?: readonly ExternalizedBundledPluginBridge[];
  logger?: PluginUpdateLogger;
  onIntegrityDrift?: (params: PluginUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
  beforePersistentEffect?: () => void;
}): Promise<PluginCohortConvergenceResult> {
  return await withPluginLifecycleLease(
    { env: params.env, assertCurrent: params.beforePersistentEffect },
    () => convergePluginReleaseCohortWithLease(params),
  );
}

async function convergePluginReleaseCohortWithLease(
  params: Parameters<typeof convergePluginReleaseCohort>[0],
): Promise<PluginCohortConvergenceResult> {
  const operatorManaged: PluginUpdateOutcome[] = [];
  const operatorManagedIds = new Set<string>();
  // Resolve explicit source selection before channel sync can replace its shadowed record.
  if (params.config.plugins?.load?.paths?.length) {
    const index = withPluginCache(createPluginCache(), () =>
      loadInstalledPluginIndex({
        config: params.config,
        installRecords: params.config.plugins?.installs ?? {},
        workspaceDir: params.workspaceDir,
        env: params.env,
      }),
    );
    const resolver = createInstalledPluginOwnershipResolver(index, params.env);
    for (const plugin of index.plugins) {
      if (plugin.origin !== "config") {
        continue;
      }
      const resolved = resolver.resolveUpdate(plugin.pluginId);
      if (!resolved.ok) {
        throw new Error(resolved.error);
      }
      if (resolved.value.kind !== "operator-managed") {
        continue;
      }
      const { source, rootDir, shadowedInstallOwner, shadowedInstallRecord } = resolved.value;
      operatorManagedIds.add(plugin.pluginId);
      if (shadowedInstallOwner) {
        operatorManagedIds.add(shadowedInstallOwner);
      }
      const shadowed = shadowedInstallRecord
        ? ` It shadows the ${shadowedInstallRecord.source} install ${shadowedInstallRecord.spec ?? plugin.pluginId}${shadowedInstallRecord.installPath ? ` at ${shadowedInstallRecord.installPath}` : ""}.`
        : "";
      const guidance = `This copy was not updated; verify it against ${params.coreVersion ?? "the updated OpenClaw version"} or remove it from plugins.load.paths.`;
      const message = `Plugin "${plugin.pluginId}" is operator-managed by plugins.load.paths. ${guidance} Source: ${rootDir}.${shadowed}`;
      operatorManaged.push({
        pluginId: plugin.pluginId,
        status: "skipped",
        code: "plugin-operator-managed",
        source,
        rootDir,
        shadowedInstallOwner,
        shadowedInstallRecord,
        message,
        guidance: [guidance],
      });
      params.logger?.warn?.(message);
    }
  }
  const sync = await syncPluginsForUpdateChannel({
    config: params.config,
    channel: params.channel,
    timeoutMs: params.timeoutMs,
    workTimeoutMs: params.workTimeoutMs,
    coreVersion: params.coreVersion,
    skipIds: operatorManagedIds,
    workspaceDir: params.workspaceDir,
    env: params.env,
    externalizedBundledPluginBridges: params.externalizedBundledPluginBridges,
    logger: params.logger,
    onCapabilityConsent: params.onCapabilityConsent,
    beforePersistentEffect: params.beforePersistentEffect,
  });
  params.beforePersistentEffect?.();
  let config = sync.config;
  const npmInstallSpecOverrides = params.coreVersion
    ? resolveOfficialPluginCohortNpmSpecs({
        gatewayVersion: params.coreVersion,
        installRecords: config.plugins?.installs ?? {},
        config,
      })
    : undefined;
  let changed = sync.changed;
  let npmChanged = false;
  let installOwners = Object.entries(config.plugins?.installs ?? {})
    .filter(
      ([id, record]) => !operatorManagedIds.has(id) && isPluginInstallRecordUpdateSource(record),
    )
    .map(([id]) => id);
  if (installOwners.length > 0) {
    const sourceBundledIds = resolveSourceCheckoutBundledPluginIds({
      config,
      installRecords: config.plugins?.installs ?? {},
      env: params.env,
    });
    installOwners = installOwners.filter((id) => !sourceBundledIds.has(id));
  }
  // Without prior package owners there is no retired child policy to reconcile.
  const beforeIndex = installOwners.length
    ? withPluginCache(createPluginCache(), () =>
        loadInstalledPluginIndex({
          config,
          installRecords: config.plugins?.installs ?? {},
          workspaceDir: params.workspaceDir,
          env: params.env,
        }),
      )
    : undefined;
  const packageUpdateSnapshot = beforeIndex
    ? capturePluginPackageUpdateSnapshot({
        index: beforeIndex,
        installOwners,
        env: params.env,
      })
    : undefined;
  if (packageUpdateSnapshot && !packageUpdateSnapshot.ok) {
    throw new Error(packageUpdateSnapshot.error);
  }
  const installOwnerMigrations: Record<string, string> = {};
  const missingPayloads = (
    await collectMissingPluginInstallPayloads({
      // Channel synchronization can replace npm paths with bundled sources.
      records: config.plugins?.installs ?? {},
      config,
      skipDisabledPlugins: true,
      syncOfficialPluginInstalls: true,
      env: params.env,
    })
  ).filter((entry) => !operatorManagedIds.has(entry.pluginId));
  const repairedMissingPayloadIds = new Set(missingPayloads.map((entry) => entry.pluginId));
  const updateInstalled = async (
    selection: Pick<Parameters<typeof updateNpmInstalledPlugins>[0], "pluginIds" | "skipIds">,
  ) => {
    const result = await updateNpmInstalledPlugins({
      config,
      npmInstallSpecOverrides,
      ...selection,
      timeoutMs: params.timeoutMs,
      workTimeoutMs: params.workTimeoutMs,
      updateChannel: params.channel,
      coreVersion: params.coreVersion,
      versionBoundPluginIds: params.versionBoundPluginIds,
      skipDisabledPlugins: true,
      syncOfficialPluginInstalls: true,
      retainOnUnavailable: true,
      logger: params.logger,
      onIntegrityDrift: params.onIntegrityDrift,
      onCapabilityConsent: params.onCapabilityConsent,
      beforePersistentEffect: params.beforePersistentEffect,
    });
    params.beforePersistentEffect?.();
    config = result.config;
    changed ||= result.changed;
    npmChanged ||= result.changed;
    Object.assign(installOwnerMigrations, resolvePluginInstallOwnerMigrations(result));
    return result.outcomes;
  };
  const repairOutcomes = repairedMissingPayloadIds.size
    ? await updateInstalled({ pluginIds: [...repairedMissingPayloadIds] })
    : [];

  const updateOutcomes = await updateInstalled({
    skipIds: new Set([
      ...operatorManagedIds,
      ...sync.summary.switchedToClawHub,
      ...sync.summary.switchedToNpm,
      ...repairedMissingPayloadIds,
      ...Object.values(installOwnerMigrations),
    ]),
  });

  if (beforeIndex && packageUpdateSnapshot) {
    // Reinstall can restore the same path. Reconciliation needs new filesystem facts,
    // including formerly missing files, without retiring a retained runtime generation.
    const afterIndex = withPluginCache(createPluginCache(), () =>
      loadInstalledPluginIndex({
        config,
        installRecords: config.plugins?.installs ?? {},
        workspaceDir: params.workspaceDir,
        env: params.env,
      }),
    );
    const reconciled = reconcilePluginPackageUpdateConfig({
      config,
      beforeIndex,
      afterIndex,
      snapshot: packageUpdateSnapshot.value,
      installOwnerMigrations,
      env: params.env,
    });
    if (!reconciled.ok) {
      throw new Error(reconciled.error);
    }
    changed ||= reconciled.config !== config;
    config = reconciled.config;
  }

  const result: PluginCohortConvergenceResult = {
    config,
    changed,
    npmChanged,
    sync,
    missingPayloads,
    repairedMissingPayloadIds,
    repairOutcomes,
    updateOutcomes: [
      ...operatorManaged,
      ...updateOutcomes.filter(
        (outcome) =>
          !operatorManagedIds.has(outcome.pluginId) &&
          (outcome.status !== "skipped" || !repairedMissingPayloadIds.has(outcome.pluginId)),
      ),
    ],
    remainingMissingPayloads: (
      await collectMissingPluginInstallPayloads({
        records: config.plugins?.installs ?? {},
        config,
        skipDisabledPlugins: true,
        syncOfficialPluginInstalls: true,
        env: params.env,
      })
    ).filter((entry) => !operatorManagedIds.has(entry.pluginId)),
  };
  return Object.keys(installOwnerMigrations).length > 0
    ? attachPluginInstallOwnerMigrations(result, installOwnerMigrations)
    : result;
}
