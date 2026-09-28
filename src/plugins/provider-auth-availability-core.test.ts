import { beforeEach, describe, expect, it, vi } from "vitest";
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
  const auth = createProviderAuthAvailability({
    ensureAuthProfileStore: vi.fn(() => store),
    findPersistedAuthProfileCredential: vi.fn(({ profileId }) => store.profiles[profileId]),
    loadAuthProfileStoreForSecretsRuntime: vi.fn(() => store),
    loadAuthProfileStoreWithoutExternalProfiles: vi.fn(() => store),
  });

  beforeEach(() => {
    resolveApiKeyForProfile.mockReset();
    resolveApiKeyForProfile.mockImplementation(async ({ profileId }) => ({
      apiKey: profileId,
      profileId,
      credential: store.profiles[profileId],
    }));
  });

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
});
