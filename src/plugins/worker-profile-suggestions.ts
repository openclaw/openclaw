import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizePluginsConfig } from "./config-state.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import {
  listAvailableManifestContractPlugins,
  loadManifestMetadataSnapshot,
} from "./manifest-contract-eligibility.js";
import { passesManifestOwnerBasePolicy } from "./manifest-owner-policy.js";
import { preparePluginModule } from "./plugin-module-loader-cache.js";
import { getPluginSetupModuleLoader } from "./plugin-setup-module.js";
import { resolvePluginRootPublicSurfaceLocation } from "./public-surface-runtime.js";
import type {
  SuggestedWorkerProfile,
  WorkerProfileSuggestionDiscovery,
} from "./worker-profile-suggestion.types.js";

const log = createSubsystemLogger("plugins");

/** Reads only declared setup surfaces; configured profiles remain the sole placement authority. */
export async function resolveSuggestedWorkerProfile(params: {
  config: OpenClawConfig;
  refresh?: boolean;
}): Promise<SuggestedWorkerProfile | undefined> {
  if (Object.keys(params.config.cloudWorkers?.profiles ?? {}).length > 0) {
    return undefined;
  }
  const normalizedConfig = normalizePluginsConfig(params.config.plugins);
  const snapshot = loadManifestMetadataSnapshot({ config: params.config });
  const owners = listAvailableManifestContractPlugins({
    snapshot,
    config: params.config,
    contract: "workerProfileSuggestions",
  }).filter((plugin) => passesManifestOwnerBasePolicy({ plugin, normalizedConfig }));
  for (const owner of owners) {
    try {
      const location = resolvePluginRootPublicSurfaceLocation({
        pluginRoot: owner.rootDir,
        pluginId: owner.id,
        entrySource: owner.source,
        artifactBasename: "worker-profile-api.js",
      });
      if (!location) {
        throw new Error("missing worker-profile-api discovery artifact");
      }
      const source = preparePluginModule({
        ...location,
        boundaryLabel: "plugin root",
        surfaceLabel: "worker profile discovery",
        origin: owner.origin,
        pluginId: owner.id,
        rejectHardlinks: shouldRejectHardlinkedPluginFiles(owner),
      }).modulePath;
      const loader = getPluginSetupModuleLoader(owner, source, location.boundaryRoot);
      const discover = loader.initialize(() => {
        const module = loader(source);
        if (
          !module ||
          typeof module !== "object" ||
          !("discoverWorkerProfile" in module) ||
          typeof module.discoverWorkerProfile !== "function"
        ) {
          throw new Error("worker-profile-api must export discoverWorkerProfile");
        }
        // SAFETY: Manifest admission owns the SDK contract; the named export was checked callable.
        return module.discoverWorkerProfile as WorkerProfileSuggestionDiscovery;
      });
      const suggestion = await discover({ refresh: params.refresh });
      if (suggestion) {
        if (!owner.contracts?.workerProfileSuggestions?.includes(suggestion.profile.provider)) {
          throw new Error("suggested profile uses an undeclared worker provider");
        }
        return suggestion;
      }
    } catch (error) {
      log.warn(`Worker profile discovery unavailable for ${owner.id}: ${String(error)}`);
    }
  }
  return undefined;
}
