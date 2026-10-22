import type { AuthHealthSummary } from "../../agents/auth-health.js";

export type HealthProfile = AuthHealthSummary["profiles"][number];

/** Build an auth-health projection independently of the RPC handler. */
export function healthProfile(
  provider: string,
  type: HealthProfile["type"],
  status: HealthProfile["status"],
  profileId = `${provider}:default`,
  extra: Partial<HealthProfile> = {},
): HealthProfile {
  return { profileId, provider, type, status, source: "store", label: profileId, ...extra };
}

/** Build a static credential profile for provider-health fixtures. */
function createApiKeyProfile(provider: string) {
  return healthProfile(provider, "api_key", "static");
}

/** Build a provider projection backed by a static API key. */
export function createStaticApiKeyProvider(provider: string) {
  return {
    provider,
    status: "static",
    profiles: [createApiKeyProfile(provider)],
  } satisfies AuthHealthSummary["providers"][number];
}

/** Build the expiring OAuth projection used by status and usage-cache cases. */
export function createOpenAiCodexOauthHealthSummary(): AuthHealthSummary {
  const profile = healthProfile("openai", "oauth", "ok", "openai:default", {
    expiresAt: 1_000_000,
    remainingMs: 60_000,
  });
  return {
    now: 0,
    warnAfterMs: 0,
    profiles: [profile],
    providers: [
      {
        provider: "openai",
        status: "ok",
        expiresAt: 1_000_000,
        remainingMs: 60_000,
        profiles: [profile],
      },
    ],
  };
}
