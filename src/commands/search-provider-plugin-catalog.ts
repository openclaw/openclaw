import { tavilySearchInstallCatalogEntry } from "../../extensions/tavily-search/install-catalog.js";
import type { InstallablePluginCatalogEntry } from "./onboarding/plugin-install.js";

export type InstallableSearchProviderPluginCatalogEntry = InstallablePluginCatalogEntry & {
  providerId: string;
  description: string;
};

export const SEARCH_PROVIDER_PLUGIN_INSTALL_CATALOG: readonly InstallableSearchProviderPluginCatalogEntry[] =
  [tavilySearchInstallCatalogEntry];
