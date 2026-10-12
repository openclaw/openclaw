import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { createProviderAuthAvailability } from "./provider-auth-availability-core.js";

const { resolveApiKeyForProfile } = vi.hoisted(() => ({ resolveApiKeyForProfile: vi.fn() }));
vi.mock("../agents/auth-profiles/oauth.js", () => ({ resolveApiKeyForProfile }));

describe("capability-aware provider auth", () => {
  const oauth = {
    type: "oauth" as const,
    provider: "openai",
    access: "synthetic-access",
    refresh: "synthetic-refresh",
    expires: Date.now() + 60_000,
  };
  const store: AuthProfileStore = {
    version: 1,
    profiles: {
      "openai:siwc": { ...oauth, authFlow: "chatgpt-token-sharing" },
      "openai:codex": oauth,
      "openai:key": { type: "api_key", provider: "openai", key: "synthetic-key" },
    },
  };
  const cfg = { auth: { order: { openai: ["openai:siwc", "openai:codex", "openai:key"] } } };
  const authStore = {
    ensureAuthProfileStore: vi.fn(() => store),
    ensureAuthProfileStoreAsync: vi.fn(async () => store),
    loadAuthProfileStoreWithoutExternalProfilesAsync: vi.fn(async () => store),
    loadAuthProfileStoreForRuntimeAsync: vi.fn(async () => store),
    findPersistedAuthProfileCredential: vi.fn(({ profileId }) => store.profiles[profileId]),
    findPersistedAuthProfileCredentialAsync: vi.fn(
      async ({ profileId }) => store.profiles[profileId],
    ),
    loadAuthProfileStoreForSecretsRuntime: vi.fn(() => store),
    loadAuthProfileStoreWithoutExternalProfiles: vi.fn(() => store),
  };
  const auth = createProviderAuthAvailability(authStore);

  beforeEach(() => {
    resolveApiKeyForProfile.mockReset();
    resolveApiKeyForProfile.mockImplementation(async ({ profileId }) => ({
      apiKey: profileId,
      profileId,
      credential: store.profiles[profileId],
    }));
  });

  afterEach(() => vi.unstubAllEnvs());

  it("skips unsupported profiles before refreshing and selects supported media auth", async () => {
    expect(
      auth.listUsableProviderAuthProfileIds({
        provider: "openai",
        capability: "image-generation",
        cfg,
      }).profileIds,
    ).toEqual(["openai:codex", "openai:key"]);
    await expect(
      auth.resolveProviderAuthProfileApiKey({
        provider: "openai",
        capability: "image-generation",
        cfg,
      }),
    ).resolves.toBe("openai:codex");
    expect(resolveApiKeyForProfile.mock.calls.map(([params]) => params.profileId)).toEqual([
      "openai:codex",
    ]);
  });

  it("rechecks the resolved credential before using an eligible profile's bearer", async () => {
    resolveApiKeyForProfile.mockResolvedValueOnce({
      apiKey: "synthetic-siwc-access",
      profileId: "openai:siwc",
      credential: store.profiles["openai:siwc"],
    });
    await expect(
      auth.resolveProviderAuthProfileApiKey({
        provider: "openai",
        capability: "image-generation",
        cfg,
      }),
    ).resolves.toBe("openai:key");
  });

  it("checks the persisted selected key instead of a profile id or runtime overlay", async () => {
    const configured = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://example.test/v1",
            apiKey: "openai:key",
            models: [],
          },
        },
      },
    };
    const params = {
      provider: "openai",
      cfg: configured,
      agentDir: "/synthetic/agent",
      store: {
        version: 1,
        profiles: {
          "openai:key": {
            type: "api_key" as const,
            provider: "openai",
            key: "runtime-overlay",
          },
        },
      },
    };
    await expect(
      auth.isProviderApiKeyConfiguredAsync({
        ...params,
        acceptsApiKey: (key) => key === "synthetic-key",
      }),
    ).resolves.toBe(true);
    await expect(
      auth.isProviderApiKeyConfiguredAsync({
        ...params,
        acceptsApiKey: (key) => key === "runtime-overlay" || key === "openai:key",
      }),
    ).resolves.toBe(false);
  });

  it("answers config-only availability without opening an auth store", async () => {
    const params = {
      provider: "openai",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://example.test/v1",
              apiKey: "config-only-key",
              models: [],
            },
          },
        },
      },
      agentDir: "/synthetic/agent",
    };
    authStore.ensureAuthProfileStore.mockClear();
    authStore.ensureAuthProfileStoreAsync.mockClear();
    await expect(auth.isProviderApiKeyConfiguredAsync(params)).resolves.toBe(true);
    expect(authStore.ensureAuthProfileStore).not.toHaveBeenCalled();
    expect(authStore.ensureAuthProfileStoreAsync).not.toHaveBeenCalled();
  });

  it("rejects a selected local profile even when the environment key is acceptable", async () => {
    vi.stubEnv("OPENAI_API_KEY", "acceptable-env-key");
    authStore.ensureAuthProfileStore.mockClear();
    authStore.ensureAuthProfileStoreAsync.mockClear();
    await expect(
      auth.isProviderApiKeyConfiguredAsync({
        provider: "openai",
        cfg: { auth: { order: { openai: ["openai:key"] } } },
        agentDir: "/synthetic/agent",
        acceptsApiKey: (key) => key === "acceptable-env-key",
      }),
    ).resolves.toBe(false);
    expect(authStore.ensureAuthProfileStore).not.toHaveBeenCalled();
    expect(authStore.ensureAuthProfileStoreAsync).toHaveBeenCalledOnce();
  });
});
