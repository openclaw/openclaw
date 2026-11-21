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

const OPENAI_DEFAULT_PROFILE = "openai:default";
const configuredOAuthProvider = {
  baseUrl: "https://example.invalid/v1",
  apiKey: OPENAI_DEFAULT_PROFILE,
  models: [],
};
export const configBoundOAuthOwnershipCases = [
  { name: "local", local: [OPENAI_DEFAULT_PROFILE], external: [], supported: true },
  { name: "inherited", local: [], external: [], supported: false },
  { name: "external", local: [], external: [OPENAI_DEFAULT_PROFILE], supported: false },
  {
    name: "external even with a local overlap",
    local: [OPENAI_DEFAULT_PROFILE],
    external: [OPENAI_DEFAULT_PROFILE],
    supported: false,
  },
  { name: "unknown ownership", local: undefined, external: [], supported: false },
].map(({ name, local, external, supported }) => ({
  name,
  config: { models: { providers: { openai: configuredOAuthProvider } } },
  store: {
    version: 1,
    profiles: { [OPENAI_DEFAULT_PROFILE]: oauthCredential("openai") },
    runtimeLocalProfileIds: local,
    runtimeExternalProfileIds: external,
  },
  supported,
  logoutSupported: external.length ? undefined : true,
}));
