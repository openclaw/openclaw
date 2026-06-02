import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  WebSearchCredentialResolutionSource,
  WebSearchProviderSetupContext,
  WebSearchProviderPlugin,
  WebSearchProviderToolDefinition,
  WebSearchProviderToolExecutionContext,
} from "../plugins/types.js";
import { enablePluginInConfig } from "./provider-enable-config.js";
import {
  createBaseWebSearchProviderContractFields,
  type CreateWebSearchProviderContractFieldsOptions,
} from "./provider-web-search-contract-fields.js";
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
  WebSearchProviderToolExecutionContext,
};
export type {
  CreateWebSearchProviderContractFieldsOptions,
  WebSearchProviderConfiguredCredential,
  WebSearchProviderContractCredential,
  WebSearchProviderContractFields,
} from "./provider-web-search-contract-fields.js";

type CreateWebSearchProviderSelectionOptions = CreateWebSearchProviderContractFieldsOptions & {
  /** Plugin id enabled when a user selects this provider from setup/tool flows. */
  selectionPluginId?: string;
};

/** Build web-search provider fields, optionally including provider-selection config enablement. */
export function createWebSearchProviderContractFields(
  options: CreateWebSearchProviderSelectionOptions,
): Pick<
  WebSearchProviderPlugin,
  "inactiveSecretPaths" | "getCredentialValue" | "setCredentialValue"
> &
  Partial<
    Pick<
      WebSearchProviderPlugin,
      "applySelectionConfig" | "getConfiguredCredentialValue" | "setConfiguredCredentialValue"
    >
  > {
  const selectionPluginId = options.selectionPluginId;

  return {
    ...createBaseWebSearchProviderContractFields(options),
    ...(selectionPluginId
      ? {
          // Selection enables the provider plugin entry, but does not apply
          // channel-style normalization or other plugin install side effects.
          applySelectionConfig: (config: OpenClawConfig) =>
            enablePluginInConfig(config, selectionPluginId).config,
        }
      : {}),
  };
}
