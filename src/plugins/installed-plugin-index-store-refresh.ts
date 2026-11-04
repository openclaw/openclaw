/** Builds refresh projections; the installed-index writer owns publication and receipts. */
import { existsSync } from "node:fs";
import { resolveUserPath } from "../infra/home-dir.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import type { PluginCandidate } from "./discovery.types.js";
import type { PluginInstallRoots } from "./install-root-context.js";
import { hashStableJson } from "./installed-plugin-index-hash.js";
import { resolveInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { resolveCompatRegistryVersion } from "./installed-plugin-index-policy.js";
import { findForeignManagedNpmInstallRecordPluginIds } from "./installed-plugin-index-record-reader.js";
import {
  readPersistedInstalledPluginIndexSync,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store.js";
import {
  extractPluginInstallRecordsFromInstalledPluginIndex,
  hasInstalledPluginIndexWorkspaceScopeMismatch,
  hasMissingConfigPathActivationMetadata,
  INSTALLED_PLUGIN_INDEX_VERSION,
  INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
  projectInstalledPluginIndexPolicy,
  resolveInstalledPluginIndexPolicyHash,
  refreshInstalledPluginIndex,
  type InstalledPluginIndex,
  type RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index.js";
import { hasMissingInstalledPluginOwnerMetadata } from "./installed-plugin-package-ownership.js";

export type PreparedPluginCandidate = {
  candidate: PluginCandidate;
  installOwner?: string;
  ambiguous: boolean;
};

export type PreparedInstalledPluginIndexRefresh = Omit<
  RefreshInstalledPluginIndexParams,
  "now" | "candidates" | "discovery"
> &
  InstalledPluginIndexStoreOptions & {
    env: NodeJS.ProcessEnv;
    installRoots: PluginInstallRoots;
    candidates?: PreparedPluginCandidate[];
    discovery?: {
      candidates: PreparedPluginCandidate[];
      diagnostics: NonNullable<RefreshInstalledPluginIndexParams["discovery"]>["diagnostics"];
    };
    nowMs?: number;
  };

function hasCompletePolicyRefreshProjection(
  persisted: InstalledPluginIndex,
  policyPluginIds: readonly string[] | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  const pluginIds = new Set(persisted.plugins.map((plugin) => plugin.pluginId));
  if (policyPluginIds?.some((pluginId) => !pluginIds.has(pluginId))) {
    return false;
  }
  const installOwners = new Set(persisted.plugins.map(resolveInstalledPluginIndexInstallOwner));
  return Object.entries(persisted.installRecords).every(([installOwner, record]) => {
    if (installOwners.has(installOwner)) {
      return true;
    }
    const installedPath = record.installPath?.trim() || record.sourcePath?.trim();
    // Missing package bytes are orphaned owner records, not rediscoverable plugins.
    return !installedPath || !existsSync(resolveUserPath(installedPath, env));
  });
}

function canRefreshPersistedPolicyState(
  persisted: InstalledPluginIndex | null,
  params: RefreshInstalledPluginIndexParams & InstalledPluginIndexStoreOptions,
): persisted is InstalledPluginIndex {
  if (!persisted || params.reason !== "policy-changed") {
    return false;
  }
  if (
    (params.diagnostics?.length ?? 0) > 0 ||
    persisted.diagnostics.some((diagnostic) => diagnostic.code === "workspace-scope-omitted") ||
    hasInstalledPluginIndexWorkspaceScopeMismatch(persisted, params.workspaceDir)
  ) {
    return false;
  }
  const env = params.env ?? process.env;
  if (
    persisted.version !== INSTALLED_PLUGIN_INDEX_VERSION ||
    persisted.hostContractVersion !== resolveCompatibilityHostVersion(env) ||
    persisted.compatRegistryVersion !== resolveCompatRegistryVersion() ||
    persisted.migrationVersion !== INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION ||
    hasMissingConfigPathActivationMetadata(persisted) ||
    hasMissingInstalledPluginOwnerMetadata(persisted, env)
  ) {
    return false;
  }
  if (
    params.installRecords &&
    hashStableJson(params.installRecords) !== hashStableJson(persisted.installRecords ?? {})
  ) {
    return false;
  }
  return hasCompletePolicyRefreshProjection(persisted, params.policyPluginIds, env);
}

function refreshPersistedPolicyState(
  persisted: InstalledPluginIndex,
  params: RefreshInstalledPluginIndexParams,
): InstalledPluginIndex {
  // Keep the existing ambient discovery-read behavior. Forwarding
  // artifactPreservingReadOnly here would change this refresh's memo/snapshot scope.
  const plugins = projectInstalledPluginIndexPolicy({
    plugins: persisted.plugins,
    config: params.config,
    env: params.env ?? process.env,
  });
  return {
    ...persisted,
    policyHash: resolveInstalledPluginIndexPolicyHash(params.config, params.env),
    generatedAtMs: (params.now?.() ?? new Date()).getTime(),
    refreshReason: params.reason,
    plugins,
  };
}

export function resolveRefreshedPersistedInstalledPluginIndex(
  params: RefreshInstalledPluginIndexParams & InstalledPluginIndexStoreOptions,
): InstalledPluginIndex {
  const persisted =
    params.reason === "policy-changed" || !params.installRecords
      ? readPersistedInstalledPluginIndexSync(params)
      : null;
  if (canRefreshPersistedPolicyState(persisted, params)) {
    return refreshPersistedPolicyState(persisted, params);
  }
  if (params.reason === "manual" && !params.installRecords) {
    const foreignPluginIds = findForeignManagedNpmInstallRecordPluginIds(
      extractPluginInstallRecordsFromInstalledPluginIndex(persisted),
      params,
    );
    if (foreignPluginIds.length > 0) {
      throw new Error(
        `Plugin registry refresh cannot verify npm install ownership outside the selected state directory: ${foreignPluginIds.join(", ")}. Reinstall copied plugins in this state directory, then run \`openclaw plugins registry --refresh\` again.`,
      );
    }
  }
  return refreshInstalledPluginIndex({
    ...params,
    installRecords:
      params.installRecords ?? extractPluginInstallRecordsFromInstalledPluginIndex(persisted),
  });
}
