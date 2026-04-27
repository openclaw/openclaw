export {
  expectAugmentedCodexCatalog,
  expectedAugmentedOpenaiCodexCatalogEntriesWithGpt55,
  expectCodexBuiltInSuppression,
  expectCodexMissingAuthHint,
} from "../../../src/plugins/provider-runtime.test-support.js";
export type { ProviderPlugin } from "../../../src/plugins/types.js";
export {
  loadBundledPluginPublicSurface,
  loadBundledPluginPublicSurfaceSync,
} from "../../../src/test-utils/bundled-plugin-public-surface.js";

type ProviderRuntimeCatalogModule = Pick<
  typeof import("openclaw/plugin-sdk/provider-catalog-runtime"),
  | "augmentModelCatalogWithProviderPlugins"
  | "resetProviderRuntimeHookCacheForTest"
  | "resolveProviderBuiltInModelSuppression"
>;

export async function importProviderRuntimeCatalogModule(): Promise<ProviderRuntimeCatalogModule> {
  const {
    augmentModelCatalogWithProviderPlugins,
    resetProviderRuntimeHookCacheForTest,
    resolveProviderBuiltInModelSuppression,
  } = await import("openclaw/plugin-sdk/provider-catalog-runtime");
  return {
    augmentModelCatalogWithProviderPlugins,
    resetProviderRuntimeHookCacheForTest,
    resolveProviderBuiltInModelSuppression,
  };
}
