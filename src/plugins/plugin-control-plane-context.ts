import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "./manifest-registry-installed.js";
import { resolvePluginCacheInputs, type PluginSourceRoots } from "./roots.js";

export type PluginDiscoveryContext = {
  /** Roots that plugin discovery scans for bundled, global, and workspace plugins. */
  roots: PluginSourceRoots;
  /** Extra explicit plugin load paths, kept in precedence order. */
  loadPaths: readonly string[];
};

/** Stable inputs that decide whether plugin control-plane metadata/cache entries are reusable. */
export type PluginControlPlaneContext = {
  discovery: PluginDiscoveryContext;
  policyFingerprint: string;
  inventoryFingerprint?: string;
  activationFingerprint?: string;
};

export type ResolvePluginDiscoveryContextParams = {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  loadPaths?: readonly string[];
};

/** Params used to build the full plugin control-plane cache/fingerprint context. */
export type ResolvePluginControlPlaneContextParams = ResolvePluginDiscoveryContextParams & {
  activationFingerprint?: string;
  index?: InstalledPluginIndex;
  inventoryFingerprint?: string;
  policyHash?: string;
};

function resolveConfiguredPluginLoadPaths(
  config: OpenClawConfig | undefined,
): readonly string[] | undefined {
  const paths = config?.plugins?.load?.paths;
  return Array.isArray(paths) ? paths : undefined;
}

export function resolvePluginDiscoveryContext(
  params: ResolvePluginDiscoveryContextParams = {},
): PluginDiscoveryContext {
  return resolvePluginCacheInputs({
    env: params.env ?? process.env,
    workspaceDir: params.workspaceDir,
    loadPaths: [...(params.loadPaths ?? resolveConfiguredPluginLoadPaths(params.config) ?? [])],
  });
}

/** Resolves and fingerprints plugin discovery roots/load paths for cache keys. */
export function resolvePluginDiscoveryFingerprint(
  params: ResolvePluginDiscoveryContextParams = {},
): string {
  return fingerprintPluginDiscoveryContext(resolvePluginDiscoveryContext(params));
}

/** Fingerprints already-resolved plugin discovery context without re-reading config/env. */
export function fingerprintPluginDiscoveryContext(context: PluginDiscoveryContext): string {
  return hashJson(context);
}

/** Resolves the plugin control-plane context from discovery, policy, inventory, and activation inputs. */
export function resolvePluginControlPlaneContext(
  params: ResolvePluginControlPlaneContextParams = {},
): PluginControlPlaneContext {
  const inventoryFingerprint =
    params.inventoryFingerprint ??
    (params.index ? resolveInstalledManifestRegistryIndexFingerprint(params.index) : undefined);
  return {
    discovery: resolvePluginDiscoveryContext(params),
    policyFingerprint: params.policyHash ?? resolveInstalledPluginIndexPolicyHash(params.config),
    ...(inventoryFingerprint ? { inventoryFingerprint } : {}),
    ...(params.activationFingerprint
      ? { activationFingerprint: params.activationFingerprint }
      : {}),
  };
}

/** Resolves and fingerprints the complete plugin control-plane context. */
export function resolvePluginControlPlaneFingerprint(
  params: ResolvePluginControlPlaneContextParams = {},
): string {
  return fingerprintPluginControlPlaneContext(resolvePluginControlPlaneContext(params));
}

function fingerprintPluginControlPlaneContext(context: PluginControlPlaneContext): string {
  return hashJson(context);
}
