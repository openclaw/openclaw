// Public contract-safe web-search registration helpers for provider plugins.

import type { SearchConfigRecord } from "../agents/tools/web-search-provider-common.js";
import {
  getScopedCredentialValue,
  getTopLevelCredentialValue,
  resolveProviderWebSearchPluginConfig,
  setScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
  setTopLevelCredentialValue,
} from "../agents/tools/web-search-provider-config.js";
import type { OpenClawConfig } from "../config/config.js";
import type {
  WebSearchCredentialResolutionSource,
  WebSearchProviderSetupContext,
  WebSearchProviderPlugin,
  WebSearchProviderToolDefinition,
} from "../plugins/types.js";
import { enablePluginInConfig } from "./provider-enable-config.js";
export {
  getScopedCredentialValue,
  getTopLevelCredentialValue,
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
  setScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
  setTopLevelCredentialValue,
} from "../agents/tools/web-search-provider-config.js";
export { enablePluginInConfig } from "./provider-enable-config.js";
export type {
  WebSearchCredentialResolutionSource,
  WebSearchProviderSetupContext,
  WebSearchProviderPlugin,
  WebSearchProviderToolDefinition,
};

type WebSearchProviderContractCredential =
  | { type: "none" }
  | { type: "top-level" }
  | { type: "scoped"; scopeId: string };

type WebSearchProviderConfiguredCredential = {
  pluginId: string;
  field?: string;
};

type CreateWebSearchProviderContractFieldsOptions = {
  credentialPath: string;
  inactiveSecretPaths?: string[];
  searchCredential: WebSearchProviderContractCredential;
  configuredCredential?: WebSearchProviderConfiguredCredential;
  selectionPluginId?: string;
};

type WebSearchProviderContractFields = Pick<
  WebSearchProviderPlugin,
  "inactiveSecretPaths" | "getCredentialValue" | "setCredentialValue"
> &
  Partial<
    Pick<
      WebSearchProviderPlugin,
      "applySelectionConfig" | "getConfiguredCredentialValue" | "setConfiguredCredentialValue"
    >
  >;

function createSearchCredentialFields(
  credential: WebSearchProviderContractCredential,
): Pick<WebSearchProviderPlugin, "getCredentialValue" | "setCredentialValue"> {
  switch (credential.type) {
    case "scoped":
      return {
        getCredentialValue: (searchConfig?: SearchConfigRecord) =>
          getScopedCredentialValue(searchConfig, credential.scopeId),
        setCredentialValue: (searchConfigTarget: SearchConfigRecord, value: unknown) =>
          setScopedCredentialValue(searchConfigTarget, credential.scopeId, value),
      };
    case "top-level":
      return {
        getCredentialValue: getTopLevelCredentialValue,
        setCredentialValue: setTopLevelCredentialValue,
      };
    case "none":
      return {
        getCredentialValue: () => undefined,
        setCredentialValue: () => {},
      };
  }
}

function createConfiguredCredentialFields(
  configuredCredential?: WebSearchProviderConfiguredCredential,
): Pick<
  WebSearchProviderPlugin,
  "getConfiguredCredentialValue" | "setConfiguredCredentialValue"
> | null {
  if (!configuredCredential) {
    return null;
  }

  const field = configuredCredential.field ?? "apiKey";

  return {
    getConfiguredCredentialValue: (config?: OpenClawConfig) =>
      resolveProviderWebSearchPluginConfig(config, configuredCredential.pluginId)?.[field],
    setConfiguredCredentialValue: (configTarget: OpenClawConfig, value: unknown) => {
      setProviderWebSearchPluginConfigValue(
        configTarget,
        configuredCredential.pluginId,
        field,
        value,
      );
    },
  };
}

export function createWebSearchProviderContractFields(
  options: CreateWebSearchProviderContractFieldsOptions,
): WebSearchProviderContractFields {
  const configuredCredentialFields = createConfiguredCredentialFields(options.configuredCredential);
  const selectionPluginId = options.selectionPluginId;

  return {
    inactiveSecretPaths:
      options.inactiveSecretPaths ?? (options.credentialPath ? [options.credentialPath] : []),
    ...createSearchCredentialFields(options.searchCredential),
    ...configuredCredentialFields,
    ...(selectionPluginId
      ? {
          applySelectionConfig: (config: OpenClawConfig) =>
            enablePluginInConfig(config, selectionPluginId).config,
        }
      : {}),
  };
}
