import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import { ensureAuthProfileStoreWithoutExternalProfilesAsync } from "../agents/auth-profiles/store-runtime.js";
import { hasAuthProfileForProvider } from "../agents/tools/model-config.helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasExistingKey, hasKeyInEnv, resolveExistingKey } from "../flows/search-setup.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
import { t } from "./i18n/index.js";

export async function resolveWebSearchCredentialSummary(params: {
  config: OpenClawConfig;
  provider: string;
  entry?: PluginWebSearchProviderEntry;
  agentDir: string;
}): Promise<{ hasCredential: boolean; keySource?: string }> {
  const { config, provider, entry, agentDir } = params;
  const storedKey = entry ? resolveExistingKey(config, provider) : undefined;
  const keyConfigured = entry ? hasExistingKey(config, provider) : false;
  const envAvailable = entry ? hasKeyInEnv(entry) : false;
  const authProviderId = entry?.authProviderId?.trim();
  const authProviderLabel = authProviderId === "xai" ? "xAI" : authProviderId;
  const authStore = authProviderId
    ? await ensureAuthProfileStoreWithoutExternalProfilesAsync(agentDir)
    : undefined;
  const providerAuthProfileAvailable = authProviderId
    ? hasAuthProfileForProvider({ provider: authProviderId, authStore })
    : false;
  const oauthAuthProfileAvailable =
    authProviderId && providerAuthProfileAvailable
      ? hasAuthProfileForProvider({ provider: authProviderId, authStore, type: "oauth" })
      : false;
  const keySource = storedKey
    ? t("wizard.finalize.webSearchKeyStored")
    : keyConfigured
      ? t("wizard.finalize.webSearchKeyRef")
      : envAvailable
        ? t("wizard.finalize.webSearchKeyEnv", {
            env: terminalText`${entry?.envVars.join(" / ") ?? ""}`,
          })
        : oauthAuthProfileAvailable && authProviderLabel
          ? t("wizard.finalize.webSearchOAuthProfile", {
              provider: terminalText`${authProviderLabel}`,
            })
          : providerAuthProfileAvailable && authProviderLabel
            ? t("wizard.finalize.webSearchAuthProfile", {
                provider: terminalText`${authProviderLabel}`,
              })
            : undefined;
  return {
    hasCredential: keyConfigured || envAvailable || providerAuthProfileAvailable,
    keySource,
  };
}
