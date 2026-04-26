import type { ModelCatalogProvider } from "../types.js";

export type OpenClawProviderIndexPlugin = {
  id: string;
  package?: string;
  source?: string;
};

export type OpenClawProviderIndexProvider = {
  id: string;
  name: string;
  plugin: OpenClawProviderIndexPlugin;
  docs?: string;
  categories?: readonly string[];
  previewCatalog?: ModelCatalogProvider;
};

export type OpenClawProviderIndex = {
  version: number;
  providers: Readonly<Record<string, OpenClawProviderIndexProvider>>;
};
