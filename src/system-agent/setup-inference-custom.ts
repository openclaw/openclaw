import { buildAuthProfileId } from "../agents/auth-profiles/identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyProviderPluginAuthMethodResultConfig } from "../plugins/provider-auth-choice.js";
import { buildApiKeyCredential } from "../plugins/provider-auth-helpers.js";
import type { ProviderAuthResult } from "../plugins/types.js";

export function prepareCustomSetupCredentials(params: {
  config: OpenClawConfig;
  providerId: string;
}): { config: OpenClawConfig; profiles: ProviderAuthResult["profiles"] } {
  const provider = params.config.models?.providers?.[params.providerId];
  const key = provider?.apiKey;
  const profiles: ProviderAuthResult["profiles"] = key
    ? [
        {
          profileId: buildAuthProfileId({ providerId: params.providerId }),
          credential: buildApiKeyCredential(params.providerId, key, undefined, {
            config: params.config,
            secretInputMode: "plaintext",
          }),
        },
      ]
    : [];
  const profile = profiles[0];
  if (
    provider?.headers?.["api-key"] &&
    profile?.credential.type === "api_key" &&
    profile.credential.key
  ) {
    profile.secretStorage = { kind: "store", namePrefix: "CUSTOM_API_KEY" };
  }
  if (provider) {
    delete provider.apiKey;
  }
  return {
    config: applyProviderPluginAuthMethodResultConfig({
      config: params.config,
      result: { profiles },
    }),
    profiles,
  };
}
