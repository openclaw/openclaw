import { isDeepStrictEqual } from "node:util";
import { resolveConfigWidePluginMetadataSnapshot } from "../../../config/io.plugin-metadata.js";
import { ConfigMutationConflictError } from "../../../config/mutation-conflict.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "../../../plugins/installed-plugin-index-records.js";
import { resolvePluginManifestInstallOwner } from "../../../plugins/manifest-install-owner.js";
import {
  getOfficialExternalPluginCatalogEntry,
  getOfficialExternalPluginCatalogEntryForPackage,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginLegacyIds,
} from "../../../plugins/official-external-plugin-catalog.js";
import { createPluginCache, withPluginCache } from "../../../plugins/plugin-cache.js";
import { migratePluginConfigId } from "../../../plugins/update-config.js";

type InstalledPluginIdOwner = {
  pluginId: string;
  rootDir: string;
  manifestHash: string;
  packageHash: string | undefined;
  record: PluginInstallRecord;
};

export type InstalledPluginIdRecovery = ReadonlyMap<string, InstalledPluginIdOwner>;

async function resolveInstalledPluginIdOwners(config: OpenClawConfig, env: NodeJS.ProcessEnv) {
  await using cache = createPluginCache();
  return withPluginCache(cache, () => {
    const records = loadInstalledPluginIndexInstallRecordsSync({ env });
    // Explicit records force complete maintenance discovery, including disabled,
    // local-load and every workspace owner; a partial runtime index cannot prove absence.
    const snapshot = resolveConfigWidePluginMetadataSnapshot({
      config,
      env,
      allowCurrent: false,
      installRecords: records,
    });
    const claimants = new Map<string, Array<(typeof snapshot.plugins)[number]>>();
    for (const plugin of snapshot.plugins) {
      for (const legacyId of new Set(plugin.legacyPluginIds ?? [])) {
        const owners = claimants.get(legacyId);
        if (owners) {
          owners.push(plugin);
        } else {
          claimants.set(legacyId, [plugin]);
        }
      }
    }
    const eligibleOwners = new Map<string, InstalledPluginIdOwner>();
    for (const [legacyId, owners] of claimants) {
      const plugin = owners[0];
      if (
        owners.length !== 1 ||
        !plugin ||
        snapshot.byPluginId.has(legacyId) ||
        Object.hasOwn(records, legacyId) ||
        snapshot.diagnostics.some(
          (diagnostic) =>
            diagnostic.level === "error" ||
            diagnostic.pluginId === legacyId ||
            diagnostic.pluginId === plugin.id,
        )
      ) {
        continue;
      }
      const record = records[plugin.id];
      const installed = snapshot.index.plugins.find(
        (entry) => entry.pluginId === plugin.id && entry.manifestPath === plugin.manifestPath,
      );
      const official = plugin.packageName
        ? getOfficialExternalPluginCatalogEntryForPackage(plugin.packageName)
        : undefined;
      // trustedOfficialInstall already binds the selected candidate's physical install
      // path and unanimous registry provenance. A local package with the same name is not authority.
      if (
        !record ||
        !installed ||
        plugin.trustedOfficialInstall !== true ||
        resolvePluginManifestInstallOwner(plugin) !== plugin.id ||
        !official ||
        resolveOfficialExternalPluginId(official) !== plugin.id ||
        !resolveOfficialExternalPluginLegacyIds(official).includes(legacyId)
      ) {
        continue;
      }
      eligibleOwners.set(legacyId, {
        pluginId: plugin.id,
        rootDir: installed.rootDir,
        manifestHash: installed.manifestHash,
        packageHash: installed.packageJson?.hash,
        record: structuredClone(record),
      });
    }
    const candidateOwners = new Map<string, string>();
    for (const [legacyId, owners] of claimants) {
      const owner = owners[0];
      if (owner) {
        candidateOwners.set(legacyId, owner.id);
      }
    }
    // A selected local shadow can hide the installed manifest's claims. Catalog
    // evidence preserves that old config; it never grants migration authority.
    for (const pluginId of Object.keys(records)) {
      const official = getOfficialExternalPluginCatalogEntry(pluginId);
      if (official && resolveOfficialExternalPluginId(official) === pluginId) {
        for (const legacyId of resolveOfficialExternalPluginLegacyIds(official)) {
          if (!candidateOwners.has(legacyId)) {
            candidateOwners.set(legacyId, pluginId);
          }
        }
      }
    }
    return { eligibleOwners, candidateOwners };
  });
}

/** Recover after install publication even when a previous config write lost its transient receipt. */
export async function recoverInstalledPluginConfigIds(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<{
  config: OpenClawConfig;
  changes: string[];
  notices: string[];
  recovery: InstalledPluginIdRecovery;
  preservePluginIds: string[];
}> {
  const { eligibleOwners, candidateOwners } = await resolveInstalledPluginIdOwners(config, env);
  const recovery = new Map<string, InstalledPluginIdOwner>();
  const changes: string[] = [];
  let nextConfig = config;
  for (const [legacyId, owner] of eligibleOwners) {
    const migrated = migratePluginConfigId(nextConfig, legacyId, owner.pluginId);
    if (migrated !== nextConfig) {
      recovery.set(legacyId, owner);
      changes.push(`Moved installed plugin config "${legacyId}" to "${owner.pluginId}".`);
      nextConfig = migrated;
    }
  }
  return {
    config: nextConfig,
    changes,
    notices: [...candidateOwners].flatMap(([legacyId, pluginId]) =>
      !eligibleOwners.has(legacyId) && migratePluginConfigId(config, legacyId, pluginId) !== config
        ? [
            `Kept plugin config "${legacyId}": the installed replacement owner is not unambiguous. Resolve plugin discovery or install-record conflicts, then rerun Doctor.`,
          ]
        : [],
    ),
    recovery,
    preservePluginIds: [...candidateOwners.keys()],
  };
}

/** Called under the existing plugin lifecycle lease before the config writer publishes. */
export async function assertInstalledPluginIdRecoveryCurrent(
  config: OpenClawConfig,
  recovery: InstalledPluginIdRecovery | undefined,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!recovery?.size) {
    return;
  }
  // Later writes already contain canonical ids; revalidate the owners of the
  // original transformations, without inventing new work for unchanged config.
  const current = await resolveInstalledPluginIdOwners(config, env);
  for (const [legacyId, owner] of recovery) {
    if (!isDeepStrictEqual(current.eligibleOwners.get(legacyId), owner)) {
      throw new ConfigMutationConflictError(
        `Plugin ownership changed after Doctor prepared "${legacyId}" config recovery; rerun Doctor.`,
        { retryable: false },
      );
    }
  }
}
