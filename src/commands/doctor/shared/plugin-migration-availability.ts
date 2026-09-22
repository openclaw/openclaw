import { cloneEnvWithPlatformSemantics } from "../../../config/config-env-vars.js";
import { resolveDeferredPluginMigrationConfigPaths } from "../../../config/deferred-plugin-migration-config.js";
import { resolveConfigWidePluginMetadataSnapshot } from "../../../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import type { DeferredPluginMigration } from "../../../infra/deferred-plugin-migrations.js";
import { normalizePluginsConfig } from "../../../plugins/config-state.js";
import { withPluginMetadataSnapshotScope } from "../../../plugins/current-plugin-metadata-snapshot.js";
import { resolvePluginDoctorContractArtifact } from "../../../plugins/doctor-contract-artifact.js";
import { createInstalledPluginIndexScopeLookup } from "../../../plugins/installed-plugin-index-scope-lookup.js";
import { resolveInstalledPluginIndexStateDatabaseOptions } from "../../../plugins/installed-plugin-index-store-path.js";
import { loadManifestMetadataSnapshot } from "../../../plugins/manifest-contract-eligibility.js";
import {
  isActivatedManifestOwner,
  passesManifestOwnerBasePolicy,
} from "../../../plugins/manifest-owner-policy.js";
import { isPayloadMissing } from "../../../plugins/payload-verification.js";
import { createPluginCache, withPluginCache } from "../../../plugins/plugin-cache.js";
import {
  isArtifactPreservingStateRead,
  withOpenClawStateDatabaseReadSnapshot,
} from "../../../state/openclaw-state-db-readonly.js";
import { collectConfiguredRuntimeIds } from "./configured-runtime-plugin-installs.js";
import {
  collectUpdateDeferredPluginIds,
  resolveConfiguredPluginInstallContext,
} from "./missing-configured-plugin-install.candidates.js";
import {
  collectBlockedPluginIds,
  collectConfiguredChannelIds,
  collectConfiguredPluginIds,
} from "./missing-configured-plugin-install.ids.js";

export type PluginMigrationInspection = {
  requiredPluginIds: readonly string[];
  inspectionRequiredPluginIds: readonly string[];
  statelessPluginIds: readonly string[];
  runtimePluginAliases: readonly string[];
};

export type PluginMigrationAvailability = PluginMigrationInspection & {
  pending: DeferredPluginMigration[];
};

/** Inspect the selected package generation without importing its Doctor contract. */
export async function inspectPluginMigrationAvailability(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  installRecords?: Record<string, PluginInstallRecord>;
  retainedPluginIds?: readonly string[];
  deferInstallation: boolean;
}): Promise<PluginMigrationAvailability> {
  const artifactPreserving = isArtifactPreservingStateRead();
  const env = artifactPreserving ? cloneEnvWithPlatformSemantics(params.env) : params.env;
  const inspect = () =>
    withPluginCache(createPluginCache(), async () => {
      const metadata =
        params.installRecords !== undefined
          ? resolveConfigWidePluginMetadataSnapshot({
              config: params.cfg,
              env,
              installRecords: params.installRecords,
              allowCurrent: false,
            })
          : loadManifestMetadataSnapshot({ config: params.cfg, env });
      return withPluginMetadataSnapshotScope(
        metadata,
        async () => {
          const configuredPluginIds = collectConfiguredPluginIds(params.cfg, env);
          const configuredChannelIds = collectConfiguredChannelIds(params.cfg, env);
          const blockedPluginIds = collectBlockedPluginIds(params.cfg);
          const context = await resolveConfiguredPluginInstallContext({
            cfg: params.cfg,
            env,
            configuredPluginIds,
            configuredChannelIds,
            blockedPluginIds,
            baselineRecords: params.installRecords,
          });
          const selected = collectUpdateDeferredPluginIds({
            cfg: params.cfg,
            env,
            configuredPluginIds,
            configuredChannelIds,
            configuredChannelOwnerPluginIds: context.configuredChannelOwnerPluginIds,
            blockedPluginIds,
          });
          const inspectedIds = new Set([...selected, ...(params.retainedPluginIds ?? [])]);
          const requiredPluginIds: string[] = [];
          const inspectionRequiredPluginIds: string[] = [];
          const statelessCandidates = new Set<string>();
          for (const plugin of metadata.plugins) {
            if (!inspectedIds.has(plugin.id)) {
              continue;
            }
            const declaration = plugin.doctorContract?.stateMigrations;
            const artifact = resolvePluginDoctorContractArtifact(plugin);
            const legacySetup =
              declaration !== true &&
              !Array.isArray(declaration) &&
              plugin.origin !== "bundled" &&
              plugin.channels.length > 0 &&
              plugin.setupSource;
            const requiresStateMigration =
              declaration === true || (Array.isArray(declaration) && declaration.length > 0);
            if (requiresStateMigration) {
              requiredPluginIds.push(plugin.id);
            } else if (
              legacySetup ||
              (artifact && (!plugin.doctorContract || Array.isArray(declaration)))
            ) {
              inspectionRequiredPluginIds.push(plugin.id);
            } else {
              statelessCandidates.add(plugin.id);
            }
          }
          const requiredIds = new Set(requiredPluginIds);
          const inspectionRequiredIds = new Set(inspectionRequiredPluginIds);
          const statelessPluginIds: string[] = [];
          const normalizedConfig = normalizePluginsConfig(params.cfg.plugins);
          const pending = [...selected].toSorted().flatMap((pluginId) => {
            if (!passesManifestOwnerBasePolicy({ plugin: { id: pluginId }, normalizedConfig })) {
              return [];
            }
            const plugin = metadata.plugins.find((candidate) => candidate.id === pluginId);
            const bundled = context.bundledPluginsById.has(pluginId);
            const unavailable =
              !context.knownIds.has(pluginId) ||
              (Object.hasOwn(context.records, pluginId) &&
                isPayloadMissing(env, context.records[pluginId]?.installPath)) ||
              context.installedPluginIdsWithRepairablePackages.has(pluginId) ||
              context.configuredPluginIdsWithStaleDescriptors.has(pluginId);
            if (
              (bundled || (!params.deferInstallation && !unavailable)) &&
              plugin &&
              statelessCandidates.has(pluginId) &&
              isActivatedManifestOwner({ plugin, normalizedConfig, rootConfig: params.cfg })
            ) {
              statelessPluginIds.push(pluginId);
            }
            if (bundled || (!params.deferInstallation && !unavailable)) {
              return [];
            }
            return [
              {
                pluginId,
                ...(requiredIds.has(pluginId) ? { requiresStateMigration: true as const } : {}),
                ...(inspectionRequiredIds.has(pluginId)
                  ? { requiresDoctorInspection: true as const }
                  : {}),
                ...resolveDeferredPluginMigrationConfigPaths({
                  config: params.cfg,
                  pluginId,
                  compatibilityMigrationPaths: plugin?.configContracts?.compatibilityMigrationPaths,
                }),
                reason: params.deferInstallation
                  ? "Package convergence must wait until the updating parent releases its install records."
                  : "The configured plugin package is missing or has not converged.",
                command: "openclaw update repair",
              },
            ];
          });
          const lookup = createInstalledPluginIndexScopeLookup(metadata.index);
          const statelessIds = new Set(statelessPluginIds);
          const runtimePluginAliases = collectConfiguredRuntimeIds(params.cfg).filter((runtime) => {
            if (
              selected.has(runtime) ||
              lookup.hasInstalledPluginIds([runtime]) ||
              Object.hasOwn(context.records, runtime) ||
              Object.hasOwn(params.cfg.plugins?.entries ?? {}, runtime)
            ) {
              return false;
            }
            const owners = new Set<string>();
            lookup.addAgentHarnessOwners(owners, [runtime]);
            return owners.size > 0 && [...owners].every((owner) => statelessIds.has(owner));
          });
          return {
            pending,
            requiredPluginIds: requiredPluginIds.toSorted(),
            inspectionRequiredPluginIds: inspectionRequiredPluginIds.toSorted(),
            statelessPluginIds,
            runtimePluginAliases,
          };
        },
        { config: params.cfg, env },
      );
    });
  // Package and catalog checks re-enter metadata after awaits; keep one view until they settle.
  return artifactPreserving
    ? withOpenClawStateDatabaseReadSnapshot(
        inspect,
        resolveInstalledPluginIndexStateDatabaseOptions({ env }),
      )
    : inspect();
}
