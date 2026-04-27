export {
  expectAugmentedCodexCatalog,
  expectedAugmentedOpenaiCodexCatalogEntriesWithGpt55,
  expectCodexBuiltInSuppression,
  expectCodexMissingAuthHint,
} from "openclaw/plugin-sdk/testing";
export type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
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
