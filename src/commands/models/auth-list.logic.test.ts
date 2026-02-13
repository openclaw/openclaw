import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { modelsAuthListLogic } from "./auth-list.logic.js";

// Mock dependencies
vi.mock("../../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir: () => "/mock/agent/dir",
}));
vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentDir: () => "/mock/agent/dir",
}));
vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: () => ({
    profiles: {
      "openai/default": { provider: "openai" },
      "anthropic/work": { provider: "anthropic" },
    },
  }),
  resolveAuthStorePathForDisplay: () => "/mock/agent/dir/auth-profiles.json",
  listProfilesForProvider: (_store: unknown, provider: string) => [`${provider}/default`],
}));
vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({}) as OpenClawConfig,
}));
vi.mock("../../utils.js", () => ({
  shortenHomePath: (p: string) => p.replace("/mock", "~"),
}));
vi.mock("./shared.js", () => ({
  resolveKnownAgentId: () => undefined,
}));
vi.mock("./list.auth-overview.js", () => ({
  resolveProfileDisplayInfos: ({ provider }: { provider: string }) => [
    {
      id: `${provider}/default`,
      profileId: `${provider}/default`,
      provider,
      type: "token",
      status: "ok",
      active: true,
    },
  ],
}));

describe("modelsAuthListLogic", () => {
  it("should list all providers when no filter is provided", async () => {
    const result = await modelsAuthListLogic({});
    expect(result.agentDir).toBe("/mock/agent/dir");
    expect(result.authStorePath).toBe("~/agent/dir/auth-profiles.json");
    // Anthropic + OpenAI
    expect(result.profiles).toHaveLength(2);
  });

  it("should filter by provider", async () => {
    const result = await modelsAuthListLogic({ provider: "openai" });
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0].id).toContain("openai");
  });
});
