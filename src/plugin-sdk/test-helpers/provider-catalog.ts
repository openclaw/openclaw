/**
 * Provider catalog contract assertions and expected Codex catalog fixtures.
 */
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, vi } from "vitest";
import { setCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata.test-support.js";
import * as jitiFactory from "../../plugins/jiti-factory.js";
import { loadPluginManifest } from "../../plugins/manifest.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";

export {
  expectAugmentedCodexCatalog,
  expectedAugmentedOpenaiCodexCatalogEntriesWithGpt55,
  expectedOpenaiPluginCodexCatalogEntriesWithGpt55,
  expectCodexMissingAuthHint,
} from "../../plugins/provider-runtime.test-support.js";
export type { ProviderPlugin } from "../provider-model-shared.js";

/** Supplies manifest facts without cold runtime discovery in provider catalog tests. */
export function useProviderCatalogMetadata(pluginRoot: URL, ...additionalPluginRoots: URL[]): void {
  const plugins = [pluginRoot, ...additionalPluginRoots].map((root) => {
    const loaded = loadPluginManifest(fileURLToPath(root));
    if (!loaded.ok) {
      throw new Error(loaded.error);
    }
    return loaded.manifest;
  });
  const snapshot = createPluginMetadataSnapshotFixture({ plugins });
  beforeEach(() => {
    setCurrentPluginMetadataSnapshot(snapshot);
    const loader = vi.spyOn(jitiFactory, "createJiti").mockImplementation(() => {
      throw new Error("Provider catalog tests must use prepared metadata without Jiti");
    });
    return () => loader.mockRestore();
  });
  afterEach(() => setCurrentPluginMetadataSnapshot(undefined));
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
