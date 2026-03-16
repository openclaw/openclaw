import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/config.js";

let mockStore: AuthProfileStore;
let mockOrder: string[];
const githubCopilotTokenRefProfile: AuthProfileStore["profiles"][string] = {
  type: "token",
  provider: "github-copilot",
  tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
};

vi.mock("../../agents/auth-health.js", () => ({
  formatRemainingShort: () => "1h",
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  isProfileInCooldown: () => false,
  resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
  resolveAuthStorePathForDisplay: () => "/tmp/auth-profiles.json",
}));

vi.mock("../../agents/model-selection.js", () => ({
  findNormalizedProviderValue: (
    values: Record<string, unknown> | undefined,
    provider: string,
  ): unknown => {
    if (!values) {
      return undefined;
    }
    return Object.entries(values).find(
      ([key]) => key.toLowerCase() === provider.toLowerCase(),
    )?.[1];
  },
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

vi.mock("../../agents/model-auth.js", () => ({
  ensureAuthProfileStore: () => mockStore,
  resolveUsableCustomProviderApiKey: () => null,
  resolveAuthProfileOrder: () => mockOrder,
  resolveEnvApiKey: () => null,
}));

const { resolveAuthLabel } = await import("./directive-handling.auth.js");

async function resolveRefOnlyAuthLabel(params: {
  provider: string;
  profileId: string;
  profile:
    | (AuthProfileStore["profiles"][string] & { type: "api_key" })
    | (AuthProfileStore["profiles"][string] & { type: "token" });
  mode: "compact" | "verbose";
}) {
  mockStore.profiles = {
    [params.profileId]: params.profile,
  };
  mockOrder = [params.profileId];

  return resolveAuthLabel(
    params.provider,
    {} as OpenClawConfig,
    "/tmp/models.json",
    undefined,
    params.mode,
  );
}

describe("resolveAuthLabel ref-aware labels", () => {
  beforeEach(() => {
    mockStore = {
      version: 1,
      profiles: {},
    };
    mockOrder = [];
  });

  it("shows api-key (ref) for keyRef-only profiles in compact mode", async () => {
    const result = await resolveRefOnlyAuthLabel({
      provider: "openai",
      profileId: "openai:default",
      profile: {
        type: "api_key",
        provider: "openai",
        keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      },
      mode: "compact",
    });

    expect(result.label).toBe("openai:default api-key (ref)");
  });

  it("shows token (ref) for tokenRef-only profiles in compact mode", async () => {
    const result = await resolveRefOnlyAuthLabel({
      provider: "github-copilot",
      profileId: "github-copilot:default",
      profile: githubCopilotTokenRefProfile,
      mode: "compact",
    });

    expect(result.label).toBe("github-copilot:default token (ref)");
  });

  it("uses token:ref instead of token:missing in verbose mode", async () => {
    const result = await resolveRefOnlyAuthLabel({
      provider: "github-copilot",
      profileId: "github-copilot:default",
      profile: githubCopilotTokenRefProfile,
      mode: "verbose",
    });

    expect(result.label).toContain("github-copilot:default=token:ref");
    expect(result.label).not.toContain("token:missing");
  });
});
