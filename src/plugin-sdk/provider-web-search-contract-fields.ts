import type { SearchConfigRecord } from "../agents/tools/web-search-provider-common.js";
import {
  getScopedCredentialValue,
  getTopLevelCredentialValue,
  resolveProviderWebSearchPluginConfig,
  setScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
  setTopLevelCredentialValue,
} from "../agents/tools/web-search-provider-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WebSearchProviderPlugin } from "../plugins/types.js";

export type WebSearchProviderContractCredential =
  | { type: "none" }
  | { type: "top-level" }
  | {
      type: "scoped";
      /** Nested provider scope inside the search config object. */
      scopeId: string;
    };

export type WebSearchProviderConfiguredCredential = {
  /** Plugin id whose config stores the credential value. */
  pluginId: string;
  /** Config field to read/write; defaults to apiKey. */
  field?: string;
};

export type CreateWebSearchProviderContractFieldsOptions = {
  /** Secret/config path advertised as inactive when the provider owns credential lookup. */
  credentialPath: string;
  /** Optional explicit inactive paths when the default credentialPath list is insufficient. */
  inactiveSecretPaths?: string[];
  /** Search-config credential layout used by runtime tool execution. */
  searchCredential: WebSearchProviderContractCredential;
  /** Root OpenClaw config credential layout used by setup/auth flows. */
  configuredCredential?: WebSearchProviderConfiguredCredential;
};

export type WebSearchProviderContractFields = Pick<
  WebSearchProviderPlugin,
  "inactiveSecretPaths" | "getCredentialValue" | "setCredentialValue"
> &
  Partial<
    Pick<WebSearchProviderPlugin, "getConfiguredCredentialValue" | "setConfiguredCredentialValue">
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
  throw new Error("Unsupported web search credential type");
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

export function createBaseWebSearchProviderContractFields(
  options: CreateWebSearchProviderContractFieldsOptions,
): WebSearchProviderContractFields {
  const configuredCredentialFields = createConfiguredCredentialFields(options.configuredCredential);

  return {
    // Empty credential paths represent keyless providers; do not advertise an
    // inactive secret that setup/doctor flows could prompt users to fill.
    inactiveSecretPaths:
      options.inactiveSecretPaths ?? (options.credentialPath ? [options.credentialPath] : []),
    ...createSearchCredentialFields(options.searchCredential),
    ...configuredCredentialFields,
  };
}
