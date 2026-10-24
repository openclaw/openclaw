import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { createProviderAuthAvailability } from "./provider-auth-availability-core.js";

const { resolveApiKeyForProfile } = vi.hoisted(() => ({ resolveApiKeyForProfile: vi.fn() }));
vi.mock("../agents/auth-profiles/oauth.js", () => ({ resolveApiKeyForProfile }));
const keyCredential = (key: string) => ({ type: "api_key" as const, provider: "openai", key });
const authProfiles = (profiles: AuthProfileStore["profiles"]) => ({ version: 1, profiles });

describe("capability-aware provider auth", () => {
  const oauth = {
    type: "oauth" as const,
    provider: "openai",
    access: "synthetic-access",
    refresh: "synthetic-refresh",
    expires: Date.now() + 60_000,
  };
  const store = authProfiles({
    "openai:siwc": { ...oauth, authFlow: "chatgpt-token-sharing" },
    "openai:codex": oauth,
    "openai:key": keyCredential("synthetic-key"),
  });
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
  const { isProviderApiKeyConfiguredAsync: isConfigured } = auth;
  const media = { provider: "openai", capability: "image-generation", cfg };
  const local = { provider: "openai", agentDir: "/synthetic/agent" };
  const configured = (apiKey: string) => ({
    ...local,
    cfg: {
      models: { providers: { openai: { baseUrl: "https://example.test/v1", apiKey, models: [] } } },
    },
  });

  beforeEach(() => {
    authStore.ensureAuthProfileStore.mockClear();
    authStore.ensureAuthProfileStoreAsync.mockClear();
    resolveApiKeyForProfile.mockReset();
    resolveApiKeyForProfile.mockImplementation(async ({ profileId }) => ({
      apiKey: profileId,
      profileId,
      credential: store.profiles[profileId],
    }));
  });

  afterEach(() => vi.unstubAllEnvs());

  it("skips unsupported profiles before refreshing and selects supported media auth", async () => {
    expect(auth.listUsableProviderAuthProfileIds(media).profileIds).toEqual([
      "openai:codex",
      "openai:key",
    ]);
    await expect(auth.resolveProviderAuthProfileApiKey(media)).resolves.toBe("openai:codex");
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
    await expect(auth.resolveProviderAuthProfileApiKey(media)).resolves.toBe("openai:key");
  });

  it("checks the persisted selected key instead of a profile id or runtime overlay", async () => {
    const params = {
      ...configured("openai:key"),
      store: authProfiles({ "openai:key": keyCredential("runtime-overlay") }),
    };
    expect(
      await isConfigured({
        ...params,
        acceptsApiKey: (key) => key === "synthetic-key",
      }),
    ).toBe(true);
    expect(
      await isConfigured({
        ...params,
        acceptsApiKey: (key) => key === "runtime-overlay" || key === "openai:key",
      }),
    ).toBe(false);
  });

  it("answers config-only availability without opening an auth store", async () => {
    expect(await isConfigured(configured("config-only-key"))).toBe(true);
    expect(authStore.ensureAuthProfileStore).not.toHaveBeenCalled();
    expect(authStore.ensureAuthProfileStoreAsync).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps persisted profile fallback and ordering (async: %s)",
    async (useAsync) => {
      const empty = authProfiles({});
      const params = {
        ...local,
        cfg: { auth: { order: { openai: ["openai:key", "openai:codex"] } } },
      };
      const fallbackAuth = createProviderAuthAvailability({
        ...authStore,
        loadAuthProfileStoreForSecretsRuntime: () => empty,
        loadAuthProfileStoreForRuntimeAsync: async () => empty,
      });
      const result = useAsync
        ? await fallbackAuth.listUsableProviderAuthProfileIdsAsync(params)
        : fallbackAuth.listUsableProviderAuthProfileIds(params);
      expect(result).toEqual({
        agentDir: local.agentDir,
        profileIds: ["openai:key", "openai:codex"],
      });
    },
  );

  it("rejects a selected local profile even when the environment key is acceptable", async () => {
    vi.stubEnv("OPENAI_API_KEY", "acceptable-env-key");
    expect(
      await isConfigured({
        ...local,
        cfg: { auth: { order: { openai: ["openai:key"] } } },
        acceptsApiKey: (key) => key === "acceptable-env-key",
      }),
    ).toBe(false);
    expect(authStore.ensureAuthProfileStore).not.toHaveBeenCalled();
    expect(authStore.ensureAuthProfileStoreAsync).toHaveBeenCalledOnce();
  });
});
