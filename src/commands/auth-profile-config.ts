import { normalizeProviderIdForAuth } from "../agents/provider-id.js";
import type { OpenClawConfig } from "../config/config.js";

export function applyAuthProfileConfig(
  cfg: OpenClawConfig,
  params: {
    profileId: string;
    provider: string;
    mode: "api_key" | "oauth" | "token";
    email?: string;
    preferProfileFirst?: boolean;
  },
): OpenClawConfig {
  const normalizedProvider = normalizeProviderIdForAuth(params.provider);
  const profiles = {
    ...cfg.auth?.profiles,
    [params.profileId]: {
      provider: params.provider,
      mode: params.mode,
      ...(params.email ? { email: params.email } : {}),
    },
  };

  const configuredProviderProfiles = Object.entries(cfg.auth?.profiles ?? {})
    .filter(([, profile]) => normalizeProviderIdForAuth(profile.provider) === normalizedProvider)
    .map(([profileId, profile]) => ({ profileId, mode: profile.mode }));

  // Maintain `auth.order` when it already exists. Additionally, if we detect
  // mixed auth modes for the same provider (e.g. legacy oauth + newly selected
  // api_key), create an explicit order to keep the newly selected profile first.
  const existingProviderOrder = cfg.auth?.order?.[params.provider];
  const preferProfileFirst = params.preferProfileFirst ?? true;
  const reorderedProviderOrder =
    existingProviderOrder && preferProfileFirst
      ? [
          params.profileId,
          ...existingProviderOrder.filter((profileId) => profileId !== params.profileId),
        ]
      : existingProviderOrder;
  const hasMixedConfiguredModes = configuredProviderProfiles.some(
    ({ profileId, mode }) => profileId !== params.profileId && mode !== params.mode,
  );
  const derivedProviderOrder =
    existingProviderOrder === undefined && preferProfileFirst && hasMixedConfiguredModes
      ? [
          params.profileId,
          ...configuredProviderProfiles
            .map(({ profileId }) => profileId)
            .filter((profileId) => profileId !== params.profileId),
        ]
      : undefined;
  const order =
    existingProviderOrder !== undefined
      ? {
          ...cfg.auth?.order,
          [params.provider]: reorderedProviderOrder?.includes(params.profileId)
            ? reorderedProviderOrder
            : [...(reorderedProviderOrder ?? []), params.profileId],
        }
      : derivedProviderOrder
        ? {
            ...cfg.auth?.order,
            [params.provider]: derivedProviderOrder,
          }
        : cfg.auth?.order;
  return {
    ...cfg,
    auth: {
      ...cfg.auth,
      profiles,
      ...(order ? { order } : {}),
    },
  };
}
