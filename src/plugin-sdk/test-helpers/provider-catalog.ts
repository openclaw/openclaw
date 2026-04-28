export {
  expectAugmentedCodexCatalog,
  expectedAugmentedOpenaiCodexCatalogEntriesWithGpt55,
  expectCodexBuiltInSuppression,
  expectCodexMissingAuthHint,
} from "../testing.js";
export type { ProviderPlugin } from "../provider-model-shared.js";
export {
  loadBundledPluginPublicSurface,
  loadBundledPluginPublicSurfaceSync,
} from "./public-surface-loader.js";

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
