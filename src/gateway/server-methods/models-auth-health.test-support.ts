import type { AuthHealthSummary } from "../../agents/auth-health.js";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";

export function oauthCredential(
  provider: string,
  overrides: Partial<Extract<AuthProfileStore["profiles"][string], { type: "oauth" }>> = {},
) {
  return {
    type: "oauth" as const,
    provider,
    access: "access",
    refresh: "refresh",
    expires: 1_000_000,
    ...overrides,
  };
}

export type HealthProfile = AuthHealthSummary["profiles"][number];

export function healthProfile(
  provider: string,
  type: HealthProfile["type"],
  status: HealthProfile["status"],
  profileId = `${provider}:default`,
  extra: Partial<HealthProfile> = {},
): HealthProfile {
  return { profileId, provider, type, status, source: "store", label: profileId, ...extra };
}

export function createStaticApiKeyProvider(provider: string) {
  return {
    provider,
    status: "static",
    profiles: [healthProfile(provider, "api_key", "static")],
  } satisfies AuthHealthSummary["providers"][number];
}
