// Runtime bridge for plugin-provided migration hooks.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import { withBundledPluginEnablementCompat } from "./bundled-compat.js";
import { listBundledPluginMetadata } from "./bundled-plugin-metadata.js";
import { isBundledProviderCompatContract } from "./bundled-provider-compat.js";
import { normalizePluginsConfig } from "./config-state.js";
import { acquirePluginRegistryForInspection } from "./loader.js";
import { isManifestPluginOwnerAllowedByControlPlanePolicy } from "./manifest-contract-eligibility.js";
import { resolveManifestContractRuntimePluginResolution } from "./manifest-contract-runtime.js";
import {
  resolveMigrationProviderPublicArtifacts,
  type MigrationProviderArtifactPlugin,
} from "./migration-provider-public-artifacts.js";
import type { PluginRegistry } from "./registry-types.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import type { MigrationProviderPlugin } from "./types.js";

type MigrationProviderPluginResolution = {
  pluginIds: string[];
  bundledCompatPluginIds: string[];
  publicPlugins: MigrationProviderArtifactPlugin[];
};

function bindMigrationProviderToRegistry(
  provider: MigrationProviderPlugin,
  registry: PluginRegistry,
): MigrationProviderPlugin {
  return {
    ...provider,
    ...(provider.detect
      ? {
          detect: (ctx) => withPluginRuntimeRegistryScope(registry, () => provider.detect!(ctx)),
        }
      : {}),
    ...(provider.prepareApply
      ? {
          prepareApply: (ctx) =>
            withPluginRuntimeRegistryScope(registry, () => provider.prepareApply!(ctx)),
        }
      : {}),
    plan: (ctx) => withPluginRuntimeRegistryScope(registry, () => provider.plan(ctx)),
    apply: (ctx, plan) => withPluginRuntimeRegistryScope(registry, () => provider.apply(ctx, plan)),
  };
}

function resolveMigrationProviderPluginResolution(params: {
  cfg?: OpenClawConfig;
  providerId?: string;
}): MigrationProviderPluginResolution {
  const resolution = resolveManifestContractRuntimePluginResolution({
    cfg: params.cfg,
    contract: "migrationProviders",
    ...(params.providerId ? { value: params.providerId } : {}),
  });
  const pluginIds = new Set(resolution.pluginIds);
  const bundledCompatPluginIds = new Set(resolution.bundledCompatPluginIds);
  const publicPlugins: MigrationProviderArtifactPlugin[] = resolution.plugins.flatMap((plugin) =>
    plugin.origin === "global" && pluginIds.has(plugin.id)
      ? [
          {
            id: plugin.id,
            origin: "global" as const,
            rootDir: plugin.rootDir,
            contracts: plugin.contracts,
          },
        ]
      : [],
  );

  const normalizedConfig = normalizePluginsConfig(params.cfg?.plugins);
  // Install migration can persist a deliberately pruned bundled-plugin index.
  // Migration contracts still need manifest discovery to repair older indexes.
  for (const plugin of listBundledPluginMetadata({ includeChannelConfigs: false })) {
    const providerIds = plugin.manifest.contracts?.migrationProviders ?? [];
    if (
      providerIds.length === 0 ||
      (params.providerId && !providerIds.includes(params.providerId)) ||
      publicPlugins.some((owner) => owner.id === plugin.manifest.id) ||
      !isManifestPluginOwnerAllowedByControlPlanePolicy({
        plugin: {
          id: plugin.manifest.id,
          origin: "bundled",
          channels: plugin.manifest.channels,
        },
        config: params.cfg,
        normalizedConfig,
        allowBundledProviderCompat: isBundledProviderCompatContract("migrationProviders"),
      })
    ) {
      continue;
    }
    pluginIds.add(plugin.manifest.id);
    bundledCompatPluginIds.add(plugin.manifest.id);
    publicPlugins.push({
      id: plugin.manifest.id,
      origin: "bundled",
      dirName: plugin.dirName,
      contracts: { migrationProviders: providerIds },
    });
  }

  return {
    pluginIds: [...pluginIds].toSorted((left, right) => left.localeCompare(right)),
    bundledCompatPluginIds: [...bundledCompatPluginIds].toSorted((left, right) =>
      left.localeCompare(right),
    ),
    publicPlugins,
  };
}

function mergeMigrationProviders(
  left: ReadonlyArray<{ provider: MigrationProviderPlugin }>,
  right: ReadonlyArray<{ provider: MigrationProviderPlugin }>,
): MigrationProviderPlugin[] {
  const merged = new Map<string, MigrationProviderPlugin>();
  for (const entry of [...left, ...right]) {
    if (!merged.has(entry.provider.id)) {
      merged.set(entry.provider.id, entry.provider);
    }
  }
  return [...merged.values()].toSorted((a, b) => a.id.localeCompare(b.id));
}

/** Keep provider callbacks and opaque plans inside the operation that owns their registration. */
export async function withPluginMigrationProviders<T>(
  params: {
    cfg?: OpenClawConfig;
    providerId?: string;
    /** Report final cleanup failure only after the consuming operation succeeded. */
    onCleanupError?: (error: unknown) => void | Promise<void>;
  },
  run: (providers: MigrationProviderPlugin[]) => Promise<T>,
): Promise<T> {
  const activeRegistry = getLoadedRuntimePluginRegistry();
  const activeProviders = activeRegistry?.migrationProviders ?? [];
  if (
    params.providerId &&
    activeProviders.some(({ provider }) => provider.id === params.providerId)
  ) {
    return await run(mergeMigrationProviders(activeProviders, []));
  }
  const resolution = resolveMigrationProviderPluginResolution(params);
  if (params.providerId) {
    const providers = resolveMigrationProviderPublicArtifacts({
      plugins: resolution.publicPlugins,
      providerId: params.providerId,
    });
    if (providers.length > 0) {
      return await run(mergeMigrationProviders(activeProviders, providers));
    }
  }
  if (
    resolution.pluginIds.length === 0 ||
    getLoadedRuntimePluginRegistry({ requiredPluginIds: resolution.pluginIds })
  ) {
    return await run(mergeMigrationProviders(activeProviders, []));
  }
  const compatConfig = withBundledPluginEnablementCompat({
    config: params.cfg,
    pluginIds: resolution.bundledCompatPluginIds,
  });
  const acquisition = await acquirePluginRegistryForInspection({
    ...(compatConfig === undefined ? {} : { config: compatConfig }),
    onlyPluginIds: resolution.pluginIds,
  });
  let result: T;
  try {
    const providers = acquisition.registry.migrationProviders.map(({ provider }) => ({
      provider: bindMigrationProviderToRegistry(provider, acquisition.registry),
    }));
    result = await run(mergeMigrationProviders(activeProviders, providers));
  } catch (error) {
    const failures = [error];
    try {
      await acquisition.release();
    } catch (disposalError) {
      failures.push(disposalError);
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "Migration failed and its plugin resources could not be disposed",
        { cause: error },
      );
    }
    throw error;
  }
  try {
    await acquisition.release();
  } catch (error) {
    if (!params.onCleanupError) {
      throw error;
    }
    await params.onCleanupError(error);
  }
  return result;
}
