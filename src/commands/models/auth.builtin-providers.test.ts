import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loginOpenAICodexOAuth: vi.fn(),
}));

vi.mock("../openai-codex-oauth.js", () => ({
  loginOpenAICodexOAuth: mocks.loginOpenAICodexOAuth,
}));

import type { ProviderAuthContext } from "../../plugins/types.js";
import { BUILTIN_AUTH_PROVIDERS } from "./auth.builtin-providers.js";

function fakeContext(): ProviderAuthContext {
  const spin = { update: vi.fn(), stop: vi.fn() };
  return {
    config: {} as ProviderAuthContext["config"],
    agentDir: undefined,
    workspaceDir: undefined,
    isRemote: false,
    openUrl: vi.fn(async () => {}),
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    prompter: {
      note: vi.fn(async () => {}),
      progress: vi.fn(() => spin),
    } as unknown as ProviderAuthContext["prompter"],
    oauth: {
      createVpsAwareHandlers: vi.fn(),
    } as unknown as ProviderAuthContext["oauth"],
  };
}

describe("BUILTIN_AUTH_PROVIDERS", () => {
  it("includes openai-codex provider", () => {
    const codex = BUILTIN_AUTH_PROVIDERS.find((p) => p.id === "openai-codex");
    expect(codex).toBeDefined();
    expect(codex?.aliases).toContain("codex");
    expect(codex?.auth).toHaveLength(1);
    expect(codex?.auth[0]?.id).toBe("oauth");
    expect(codex?.auth[0]?.kind).toBe("oauth");
  });

  describe("openai-codex oauth method", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("returns profiles with credentials on successful OAuth", async () => {
      const creds = {
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
        email: "user@example.com",
      };
      mocks.loginOpenAICodexOAuth.mockResolvedValue(creds);

      const codex = BUILTIN_AUTH_PROVIDERS.find((p) => p.id === "openai-codex")!;
      const ctx = fakeContext();
      const result = await codex.auth[0].run(ctx);

      expect(result.profiles).toHaveLength(1);
      expect(result.profiles[0]?.credential.provider).toBe("openai-codex");
      expect(result.profiles[0]?.credential.type).toBe("oauth");
      expect(result.defaultModel).toBeDefined();
    });

    it("returns empty profiles when OAuth returns null (user cancelled)", async () => {
      mocks.loginOpenAICodexOAuth.mockResolvedValue(null);

      const codex = BUILTIN_AUTH_PROVIDERS.find((p) => p.id === "openai-codex")!;
      const result = await codex.auth[0].run(fakeContext());

      expect(result.profiles).toHaveLength(0);
      expect(result.defaultModel).toBeUndefined();
    });

    it("propagates OAuth errors", async () => {
      mocks.loginOpenAICodexOAuth.mockRejectedValue(new Error("network error"));

      const codex = BUILTIN_AUTH_PROVIDERS.find((p) => p.id === "openai-codex")!;
      await expect(codex.auth[0].run(fakeContext())).rejects.toThrow("network error");
    });
  });
});
