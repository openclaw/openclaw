import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveEnabledBundledManifestContractPlugins } from "./bundled-manifest-contract-plugins.js";
import { sortPluginEntriesForAutoDetect } from "./plugin-entry-order.js";
import { loadBundledPublicArtifactEntries } from "./public-artifact-factories.js";
import type {
  PluginWebContentExtractorEntry,
  WebContentExtractorPlugin,
} from "./web-content-extractor-types.js";

export function resolvePluginWebContentExtractors(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: readonly string[];
}): PluginWebContentExtractorEntry[] {
  const extractors: PluginWebContentExtractorEntry[] = [];
  for (const plugin of resolveEnabledBundledManifestContractPlugins({
    config: params?.config,
    workspaceDir: params?.workspaceDir,
    env: params?.env,
    onlyPluginIds: params?.onlyPluginIds,
    contract: "webContentExtractors",
  })) {
    const loaded = loadBundledPublicArtifactEntries({
      dirName: plugin.id,
      pluginId: plugin.id,
      env: params?.env,
      owner: plugin,
      artifactCandidates: ["web-content-extractor.js", "web-content-extractor-api.js"],
      suffix: "WebContentExtractor",
      isArtifact: (value): value is WebContentExtractorPlugin =>
        isRecord(value) &&
        typeof value.id === "string" &&
        typeof value.label === "string" &&
        (value.autoDetectOrder === undefined || typeof value.autoDetectOrder === "number") &&
        typeof value.extract === "function",
    });
    if (loaded) {
      extractors.push(...loaded);
    }
  }
  return sortPluginEntriesForAutoDetect(extractors);
}
