import type { AuthHealthSummary } from "../../agents/auth-health.js";

export function createOpenAiCodexOauthHealthSummary(): AuthHealthSummary {
  const profile = {
    profileId: "openai:default",
    provider: "openai",
    type: "oauth",
    status: "ok",
    expiresAt: 1_000_000,
    remainingMs: 60_000,
    source: "store",
    label: "openai:default",
  } satisfies AuthHealthSummary["profiles"][number];
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

export function createApiKeyProfile(provider: string) {
  return {
    profileId: `${provider}:default`,
    provider,
    type: "api_key",
    status: "static",
    source: "store",
    label: `${provider}:default`,
  } satisfies AuthHealthSummary["profiles"][number];
}

export function createStaticApiKeyProvider(provider: string) {
  return {
    provider,
    status: "static",
    profiles: [createApiKeyProfile(provider)],
  } satisfies AuthHealthSummary["providers"][number];
}
