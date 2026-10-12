import { promoteAuthProfileInOrder } from "../../agents/auth-profiles/profiles.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ProviderCredentialsSavedError } from "../../shared/provider-auth-result.js";

export async function promotePersistedAuthProfile(params: {
  config: OpenClawConfig;
  agentDir: string;
  provider: string;
  profileId: string;
  assertCurrent?: () => void;
}): Promise<void> {
  const cfg = params.config;
  const providerAuthKey = resolveProviderIdForAuth(params.provider, { config: cfg });
  const configuredOrder = Object.entries(cfg.auth?.order ?? {}).find(
    ([orderProvider, profileIds]) =>
      profileIds.length > 0 &&
      resolveProviderIdForAuth(orderProvider, { config: cfg }) === providerAuthKey,
  )?.[1];
  const order =
    configuredOrder ??
    Object.entries(cfg.auth?.profiles ?? {})
      .filter(
        ([, profile]) =>
          resolveProviderIdForAuth(profile.provider, { config: cfg, storedCredential: true }) ===
          providerAuthKey,
      )
      .map(([profileId]) => profileId);
  const promotion = await promoteAuthProfileInOrder({
    agentDir: params.agentDir,
    provider: params.provider,
    profileId: params.profileId,
    assertCurrent: params.assertCurrent,
    createIfMissing: order.length > 0,
    ...(order.length > 0 ? { createFromOrder: order } : {}),
  });
  if (!promotion.ok) {
    throw new ProviderCredentialsSavedError(
      "The auth profile was saved, but its order could not be updated because the auth store is busy. Wait a moment, then retry the login.",
    );
  }
}
