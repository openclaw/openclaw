import { runWithLocalStateOwner } from "../cli/local-state-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { MissingPublicSurfaceError } from "../plugin-sdk/facade-loader.js";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import { withBundledPluginEnablementCompat } from "./bundled-compat.js";
import { listBundledPluginMetadata } from "./bundled-plugin-metadata.js";
import { isBundledProviderCompatContract } from "./bundled-provider-compat.js";
import { normalizePluginsConfig } from "./config-state.js";
import { acquirePluginRegistryForInspection } from "./loader.js";
import { isManifestPluginOwnerAllowedByControlPlanePolicy } from "./manifest-contract-eligibility.js";
import { resolveManifestContractRuntimePluginResolution } from "./manifest-contract-runtime.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import {
  loadBundledPluginPublicArtifactModuleSync,
  loadPluginPublicArtifactModuleSync,
} from "./public-surface-loader.js";
import type { PluginRegistry } from "./registry-types.js";
import type { MigrationProviderPlugin } from "./types.js";

const MIGRATION_PROVIDER_ARTIFACT = "migration-provider-api.js";

type MigrationProviderArtifactModule = {
  buildMigrationProvider?: () => MigrationProviderPlugin;
};

type MigrationProviderArtifactPlugin = Pick<PluginManifestRecord, "id" | "contracts"> &
  ({ origin: "bundled"; dirName: string } | { origin: "global"; rootDir: string });

function resolveMigrationProviderPublicArtifacts(params: {
  plugins: readonly MigrationProviderArtifactPlugin[];
  providerId: string;
}): Array<{ pluginId: string; provider: MigrationProviderPlugin }> {
  const providers: Array<{ pluginId: string; provider: MigrationProviderPlugin }> = [];
  for (const plugin of params.plugins) {
    const declared = plugin.contracts?.migrationProviders ?? [];
    if (declared.length === 0 || !declared.includes(params.providerId)) {
      continue;
    }
    let artifact: MigrationProviderArtifactModule;
    try {
      artifact =
        plugin.origin === "bundled"
          ? loadBundledPluginPublicArtifactModuleSync<MigrationProviderArtifactModule>({
              dirName: plugin.dirName,
              artifactBasename: MIGRATION_PROVIDER_ARTIFACT,
            })
          : loadPluginPublicArtifactModuleSync<MigrationProviderArtifactModule>({
              pluginRoot: plugin.rootDir,
              artifactBasename: MIGRATION_PROVIDER_ARTIFACT,
              origin: plugin.origin,
            });
    } catch (error) {
      if (error instanceof MissingPublicSurfaceError) {
        continue;
      }
      throw error;
    }
    if (typeof artifact.buildMigrationProvider !== "function") {
      throw new Error(
        `Plugin "${plugin.id}" has an invalid ${MIGRATION_PROVIDER_ARTIFACT}: buildMigrationProvider is required.`,
      );
    }
    const provider = artifact.buildMigrationProvider();
    if (
      provider.id !== params.providerId ||
      typeof provider.plan !== "function" ||
      typeof provider.apply !== "function"
    ) {
      throw new Error(
        `Plugin "${plugin.id}" returned an invalid migration provider from ${MIGRATION_PROVIDER_ARTIFACT}.`,
      );
    }
    const existing = providers.find((entry) => entry.provider.id === provider.id);
    if (existing) {
      throw new Error(
        `Multiple plugins declare migration provider "${provider.id}": ${existing.pluginId}, ${plugin.id}.`,
      );
    }
    providers.push({ pluginId: plugin.id, provider });
  }
  return providers;
}

type MigrationProviderPluginResolution = {
  pluginIds: string[];
  bundledCompatPluginIds: string[];
  publicPlugins: MigrationProviderArtifactPlugin[];
};

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
  ...registries: Array<
    | {
        plugins?: PluginRegistry["plugins"];
        migrationProviders: ReadonlyArray<{ pluginId: string; provider: MigrationProviderPlugin }>;
      }
    | undefined
  >
): MigrationProviderPlugin[] {
  const merged = new Map<string, MigrationProviderPlugin>();
  for (const registry of registries) {
    for (const { pluginId, provider } of registry?.migrationProviders ?? []) {
      if (!merged.has(provider.id)) {
        const record = registry?.plugins?.find((entry) => entry.id === pluginId);
        const instance = record && getPluginInstance(record);
        merged.set(provider.id, instance?.wrap(provider) ?? provider);
      }
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
  return await runWithLocalStateOwner({
    method: "migrate",
    params: {},
    target: params.providerId ?? "migration providers",
    onForeignOwner: "refuse",
    runLocal: async (scope) => {
      const { assertCurrent } = scope;
      assertCurrent();
      const config = params.cfg ?? scope.config;
      const consume = async (providers: MigrationProviderPlugin[]) => {
        assertCurrent();
        return await run(providers);
      };
      const activeRegistry = getLoadedRuntimePluginRegistry();
      const activeProviders = activeRegistry?.migrationProviders ?? [];
      if (
        params.providerId &&
        activeProviders.some(({ provider }) => provider.id === params.providerId)
      ) {
        return await consume(mergeMigrationProviders(activeRegistry));
      }
      const resolution = resolveMigrationProviderPluginResolution({ ...params, cfg: config });
      if (params.providerId) {
        const providers = resolveMigrationProviderPublicArtifacts({
          plugins: resolution.publicPlugins,
          providerId: params.providerId,
        });
        if (providers.length > 0) {
          return await consume(
            mergeMigrationProviders(activeRegistry, { migrationProviders: providers }),
          );
        }
      }
      if (
        resolution.pluginIds.length === 0 ||
        getLoadedRuntimePluginRegistry({ requiredPluginIds: resolution.pluginIds })
      ) {
        return await consume(mergeMigrationProviders(activeRegistry));
      }
      const compatConfig = withBundledPluginEnablementCompat({
        config,
        pluginIds: resolution.bundledCompatPluginIds,
      });
      const acquisition = await acquirePluginRegistryForInspection({
        ...(compatConfig === undefined ? {} : { config: compatConfig }),
        onlyPluginIds: resolution.pluginIds,
      });
      let result: T;
      try {
        result = await consume(mergeMigrationProviders(activeRegistry, acquisition.registry));
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
    },
  });
}
