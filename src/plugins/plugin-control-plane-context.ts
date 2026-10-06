import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "./manifest-registry-installed.js";
import { resolvePluginCacheInputs } from "./roots.js";

type ResolvePluginDiscoveryContextParams = {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  loadPaths?: readonly string[];
};

export type ResolvePluginControlPlaneContextParams = ResolvePluginDiscoveryContextParams & {
  activationFingerprint?: string;
  index?: InstalledPluginIndex;
  inventoryFingerprint?: string;
  policyHash?: string;
};

export function resolvePluginDiscoveryContext(
  params: ResolvePluginDiscoveryContextParams = {},
): ReturnType<typeof resolvePluginCacheInputs> {
  const paths = params.config?.plugins?.load?.paths;
  return resolvePluginCacheInputs({
    env: params.env ?? process.env,
    workspaceDir: params.workspaceDir,
    loadPaths: params.loadPaths ?? (Array.isArray(paths) ? paths : undefined),
  });
}

/** Resolves a stable fingerprint for plugin control-plane activation state. */
export function resolvePluginControlPlaneFingerprint(
  params: ResolvePluginControlPlaneContextParams = {},
): string {
  const inventoryFingerprint =
    params.inventoryFingerprint ??
    (params.index ? resolveInstalledManifestRegistryIndexFingerprint(params.index) : undefined);
  return hashJson({
    discovery: resolvePluginDiscoveryContext(params),
    policyFingerprint:
      params.policyHash ?? resolveInstalledPluginIndexPolicyHash(params.config, params.env),
    ...(inventoryFingerprint ? { inventoryFingerprint } : {}),
    ...(params.activationFingerprint
      ? { activationFingerprint: params.activationFingerprint }
      : {}),
  });
}
