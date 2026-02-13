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
  resolveProfileDisplayInfos: ({ provider }: { provider: string }) => [
    { id: `${provider}/default`, name: "Default", isDefault: true, isActive: true },
  ],
  listProfilesForProvider: ({ provider }: { provider: string }) => [
    { id: `${provider}/default`, provider, email: "mock@example.com" },
  ],
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
    console.log("DEBUG profiles:", JSON.stringify(result.profiles, null, 2));
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0].id).toContain("openai");
  });
});
