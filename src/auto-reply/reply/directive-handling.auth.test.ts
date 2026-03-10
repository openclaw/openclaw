import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/config.js";

let mockStore: AuthProfileStore;
let mockOrder: string[];

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

describe("resolveAuthLabel ref-aware labels", () => {
  beforeEach(() => {
    mockStore = {
      version: 1,
      profiles: {},
    };
    mockOrder = [];
  });

  it("shows api-key (ref) for keyRef-only profiles in compact mode", async () => {
    mockStore.profiles = {
      "openai:default": {
        type: "api_key",
        provider: "openai",
        keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      },
    };
    mockOrder = ["openai:default"];

    const result = await resolveAuthLabel(
      "openai",
      {} as OpenClawConfig,
      "/tmp/models.json",
      undefined,
      "compact",
    );

    expect(result.label).toBe("openai:default api-key (ref)");
  });

  it("shows token (ref) for tokenRef-only profiles in compact mode", async () => {
    mockStore.profiles = {
      "github-copilot:default": {
        type: "token",
        provider: "github-copilot",
        tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
      },
    };
    mockOrder = ["github-copilot:default"];

    const result = await resolveAuthLabel(
      "github-copilot",
      {} as OpenClawConfig,
      "/tmp/models.json",
      undefined,
      "compact",
    );

    expect(result.label).toBe("github-copilot:default token (ref)");
  });

  it("uses token:ref instead of token:missing in verbose mode", async () => {
    mockStore.profiles = {
      "github-copilot:default": {
        type: "token",
        provider: "github-copilot",
        tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
      },
    };
    mockOrder = ["github-copilot:default"];

    const result = await resolveAuthLabel(
      "github-copilot",
      {} as OpenClawConfig,
      "/tmp/models.json",
      undefined,
      "verbose",
    );

    expect(result.label).toContain("github-copilot:default=token:ref");
    expect(result.label).not.toContain("token:missing");
  });
});
