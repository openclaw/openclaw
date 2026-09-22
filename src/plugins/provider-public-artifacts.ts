import path from "node:path";
// Extracts provider public artifacts from plugin metadata.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import { loadPluginManifestRegistryCore, type PluginManifestRecord } from "./manifest-registry.js";
import { preparePluginModule } from "./plugin-module-loader-cache.js";
import { getPluginSetupModuleLoader } from "./plugin-setup-module.js";
import {
  listTrustedExternalProviderPolicyOwners,
  resolveBundledProviderPolicyOwner,
} from "./provider-policy-owners.js";
import {
  resolveDirectBundledProviderPolicySurface,
  extractProviderPolicySurface,
  PROVIDER_POLICY_ARTIFACT,
  type BundledProviderPolicySurface,
  type ProviderPolicySurface,
} from "./provider-policy-surface.js";
import { loadValidatedPublicSurfaceModule } from "./public-surface-loader.js";
import { resolvePluginRootPublicSurfacePath } from "./public-surface-runtime.js";
import { resolvePluginRuntimeRecord } from "./runtime-context.js";

export { listTrustedExternalProviderPolicyOwners };

type ProviderPolicyRegistry = { plugins: readonly PluginManifestRecord[] };

type ProviderPolicyMetadata = {
  manifestRegistry?: ProviderPolicyRegistry;
  loadManifestRegistry?: () => ProviderPolicyRegistry | undefined;
};

function resolveBundledProviderPolicyPlugin(
  providerId: string,
  options: ProviderPolicyMetadata = {},
): PluginManifestRecord | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return null;
  }
  const bundledPluginsDir = resolveBundledPluginsDir();
  if (!bundledPluginsDir) {
    return null;
  }

  const registry =
    options.manifestRegistry ??
    options.loadManifestRegistry?.() ??
    loadPluginManifestRegistryCore();
  return resolveBundledProviderPolicyOwner(normalizedProviderId, registry);
}

/** Resolves provider policy hooks for a bundled provider or its owning plugin. */
export function resolveBundledProviderPolicySurface(
  providerId: string,
  options: ProviderPolicyMetadata = {},
): BundledProviderPolicySurface | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return null;
  }
  const directSurface = resolveDirectBundledProviderPolicySurface(normalizedProviderId);
  if (directSurface) {
    return directSurface;
  }
  const ownerPlugin = resolveBundledProviderPolicyPlugin(normalizedProviderId, options);
  if (ownerPlugin) {
    const ownerSurface = resolveDirectBundledProviderPolicySurface(ownerPlugin.id);
    if (ownerSurface) {
      return ownerSurface;
    }
  }
  if (!ownerPlugin) {
    return null;
  }
  // A stable plugin id can differ from its stock directory name. Use the
  // registry-owned root basename so its pre-runtime policy stays discoverable.
  return resolveDirectBundledProviderPolicySurface(path.basename(ownerPlugin.rootDir));
}

/** Resolves provider policy hooks from bundled or trusted official plugin artifacts. */
export function resolveProviderPolicySurface(
  providerId: string,
  options: { manifestRegistry?: ProviderPolicyRegistry } = {},
): ProviderPolicySurface | null {
  const bundledSurface = resolveBundledProviderPolicySurface(providerId, options);
  if (bundledSurface) {
    return bundledSurface;
  }
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId || !options.manifestRegistry) {
    return null;
  }
  return (
    loadTrustedExternalProviderPolicyArtifacts(
      listTrustedExternalProviderPolicyOwners(providerId, options.manifestRegistry),
    )?.surface ?? null
  );
}

/** Loads the first usable policy surface from caller-selected trusted owners. */
export function loadTrustedExternalProviderPolicyArtifacts(
  owners: readonly PluginManifestRecord[],
) {
  for (const owner of owners) {
    const surface = resolveTrustedExternalProviderPolicySurface(owner);
    if (surface) {
      return { owner, surface };
    }
  }
  const owner = owners[0];
  return owner ? { owner, surface: null } : null;
}

/** Loads policy hooks from a host-verified official external plugin install. */
function resolveTrustedExternalProviderPolicySurface(
  record: PluginManifestRecord,
): ProviderPolicySurface | null {
  if (record.trustedOfficialInstall !== true) {
    return null;
  }
  const modulePath = resolvePluginRootPublicSurfacePath({
    pluginRoot: record.rootDir,
    pluginId: record.id,
    entrySource: record.source,
    artifactBasename: PROVIDER_POLICY_ARTIFACT,
  });
  if (!modulePath) {
    return null;
  }
  const location = {
    modulePath,
    boundaryRoot: record.rootDir,
    surfaceLabel: `plugin public surface ${PROVIDER_POLICY_ARTIFACT}`,
    origin: record.origin,
    pluginId: record.id,
  };
  const runtime = resolvePluginRuntimeRecord({ pluginRoot: record.rootDir, pluginId: record.id });
  if (runtime?.status === "loaded") {
    return extractProviderPolicySurface(
      // SAFETY: The public-artifact extractor validates each named export before exposing it.
      loadValidatedPublicSurfaceModule(location) as Record<string, unknown>,
    );
  }
  const source = preparePluginModule({
    ...location,
    boundaryLabel: "plugin root",
    rejectHardlinks: shouldRejectHardlinkedPluginFiles(record),
  }).modulePath;
  const loader = getPluginSetupModuleLoader(record, source, record.rootDir);
  return loader.initialize(() =>
    // SAFETY: The public-artifact extractor validates each named export before exposing it.
    extractProviderPolicySurface(loader(source) as Record<string, unknown>),
  );
}
