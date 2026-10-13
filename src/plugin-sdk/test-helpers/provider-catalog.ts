/**
 * Provider catalog contract assertions and expected Codex catalog fixtures.
 */
import { fileURLToPath } from "node:url";
import { aroundEach, vi } from "vitest";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { preparePluginMetadataMachineStateAsync } from "../../plugins/installed-plugin-index-record-state.js";
import * as jitiFactory from "../../plugins/jiti-factory.js";
import { loadPluginManifest } from "../../plugins/manifest.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";

export {
  expectAugmentedCodexCatalog,
  expectedAugmentedOpenaiCodexCatalogEntriesWithGpt55,
  expectedOpenaiPluginCodexCatalogEntriesWithGpt55,
  expectCodexMissingAuthHint,
} from "../../plugins/provider-runtime.test-support.js";
export type { ProviderPlugin } from "../provider-model-shared.js";

/** Supplies immutable boot facts without cold runtime discovery in provider catalog tests. */
export function useProviderCatalogMetadata(pluginRoot: URL, ...additionalPluginRoots: URL[]): void {
  const plugins = [pluginRoot, ...additionalPluginRoots].map((root) => {
    const loaded = loadPluginManifest(fileURLToPath(root));
    if (!loaded.ok) {
      throw new Error(loaded.error);
    }
    return loaded.manifest;
  });
  aroundEach(async (runTest) => {
    await using cache = createPluginCache();
    await withPluginCache(cache, async () => {
      await preparePluginMetadataMachineStateAsync({});
      const snapshot = createPluginMetadataSnapshotFixture({ plugins });
      const loader = vi.spyOn(jitiFactory, "createJiti").mockImplementation(() => {
        throw new Error("Provider catalog tests must use prepared metadata without Jiti");
      });
      try {
        // Cases vary request config and env while retaining these fixed manifest facts.
        await withPluginMetadataSnapshotScope(snapshot, runTest, { trustConfigIdentity: true });
      } finally {
        loader.mockRestore();
      }
    });
  });
}

type ProviderRuntimeCatalogModule = Pick<
  typeof import("openclaw/plugin-sdk/provider-catalog-runtime"),
  "augmentModelCatalogWithProviderPlugins"
>;

export async function importProviderRuntimeCatalogModule(): Promise<ProviderRuntimeCatalogModule> {
  const { augmentModelCatalogWithProviderPlugins } =
    await import("openclaw/plugin-sdk/provider-catalog-runtime");
  return {
    augmentModelCatalogWithProviderPlugins,
  };
}
