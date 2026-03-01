import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/config.js";

let mockStore: AuthProfileStore;
let mockAllowedProfiles: string[];
let resolvableProfiles: Set<string>;

const resolveAuthProfileOrderMock = vi.fn(() => mockAllowedProfiles);
const resolveApiKeyForProfileMock = vi.fn(
  async (params: { profileId: string }): Promise<{ apiKey: string; provider: string } | null> => {
    if (!resolvableProfiles.has(params.profileId)) {
      return null;
    }
    return { apiKey: "sk-test", provider: "anthropic" };
  },
);

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => []),
}));

vi.mock("../../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/auth-profiles.js")>();
  return {
    ...actual,
    ensureAuthProfileStore: () => mockStore,
    listProfilesForProvider: (_store: AuthProfileStore, provider: string) =>
      Object.entries(mockStore.profiles)
        .filter(
          ([, profile]) =>
            typeof profile.provider === "string" && profile.provider.toLowerCase() === provider,
        )
        .map(([profileId]) => profileId),
    resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
    resolveAuthProfileOrder: resolveAuthProfileOrderMock,
    resolveApiKeyForProfile: resolveApiKeyForProfileMock,
  };
});

const { buildProbeTargets } = await import("./list.probe.js");

describe("buildProbeTargets", () => {
  beforeEach(() => {
    mockStore = {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          keyRef: { source: "exec", provider: "keychain", id: "anthropic-default" },
        },
      },
      order: {
        anthropic: ["anthropic:default"],
      },
    };
    mockAllowedProfiles = [];
    resolvableProfiles = new Set<string>();
    resolveAuthProfileOrderMock.mockClear();
    resolveApiKeyForProfileMock.mockClear();
  });

  it("keeps SecretRef profiles probeable when deferred credential resolution succeeds", async () => {
    resolvableProfiles.add("anthropic:default");

    const plan = await buildProbeTargets({
      cfg: {} as OpenClawConfig,
      providers: ["anthropic"],
      modelCandidates: ["anthropic/claude-sonnet-4-6"],
      options: {
        timeoutMs: 5000,
        concurrency: 1,
        maxTokens: 16,
      },
    });

    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]).toMatchObject({
      provider: "anthropic",
      profileId: "anthropic:default",
      source: "profile",
      mode: "api_key",
    });
    expect(plan.results).toEqual([]);
    expect(resolveApiKeyForProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "anthropic:default" }),
    );
  });

  it("preserves missing-or-expired warning when deferred credential resolution fails", async () => {
    const plan = await buildProbeTargets({
      cfg: {} as OpenClawConfig,
      providers: ["anthropic"],
      modelCandidates: ["anthropic/claude-sonnet-4-6"],
      options: {
        timeoutMs: 5000,
        concurrency: 1,
        maxTokens: 16,
      },
    });

    expect(plan.targets).toHaveLength(0);
    expect(plan.results).toHaveLength(1);
    expect(plan.results[0]).toMatchObject({
      provider: "anthropic",
      profileId: "anthropic:default",
      status: "unknown",
      error: "Auth profile credentials are missing or expired.",
    });
  });
});
