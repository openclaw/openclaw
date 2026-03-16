import { describe, expect, it, vi } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../../test-utils/provider-usage-fetch.js";
import type { ProviderRuntimeModel } from "../types.js";

const getOAuthApiKeyMock = vi.hoisted(() => vi.fn());
const refreshQwenPortalCredentialsMock = vi.hoisted(() => vi.fn());

vi.mock("@mariozechner/pi-ai/oauth", async () => {
  const actual = await vi.importActual<object>("@mariozechner/pi-ai/oauth");
  return {
    ...actual,
    getOAuthApiKey: getOAuthApiKeyMock,
  };
});

vi.mock("../../providers/qwen-portal-oauth.js", () => ({
  refreshQwenPortalCredentials: refreshQwenPortalCredentialsMock,
}));

const { providerContractRegistry } = await import("./registry.js");

function requireProvider(providerId: string) {
  const entry = providerContractRegistry.find((candidate) => candidate.provider.id === providerId);
  if (!entry) {
    throw new Error(`provider contract entry missing for ${providerId}`);
  }
  return entry.provider;
}

function createModel(overrides: Partial<ProviderRuntimeModel> & Pick<ProviderRuntimeModel, "id">) {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    api: overrides.api ?? "openai-responses",
    provider: overrides.provider ?? "demo",
    baseUrl: overrides.baseUrl ?? "https://api.example.com/v1",
    reasoning: overrides.reasoning ?? true,
    input: overrides.input ?? ["text"],
    cost: overrides.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: overrides.contextWindow ?? 200_000,
    maxTokens: overrides.maxTokens ?? 8_192,
  } satisfies ProviderRuntimeModel;
}

describe("provider runtime contract", () => {
  describe("anthropic", () => {
    it("owns anthropic 4.6 forward-compat resolution", () => {
      const provider = requireProvider("anthropic");
      const model = provider.resolveDynamicModel?.({
        provider: "anthropic",
        modelId: "claude-sonnet-4.6-20260219",
        modelRegistry: {
          find: (_provider: string, id: string) =>
            id === "claude-sonnet-4.5-20260219"
              ? createModel({
                  id: id,
                  api: "anthropic-messages",
                  provider: "anthropic",
                  baseUrl: "https://api.anthropic.com",
                })
              : null,
        } as never,
      });

      expect(model).toMatchObject({
        id: "claude-sonnet-4.6-20260219",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      });
    });

    it("owns usage auth resolution", async () => {
      const provider = requireProvider("anthropic");
      await expect(
        provider.resolveUsageAuth?.({
          config: {} as never,
          env: {} as NodeJS.ProcessEnv,
          provider: "anthropic",
          resolveApiKeyFromConfigAndStore: () => undefined,
          resolveOAuthToken: async () => ({
            token: "anthropic-oauth-token",
          }),
        }),
      ).resolves.toEqual({
        token: "anthropic-oauth-token",
      });
    });

    it("owns auth doctor hint generation", () => {
      const provider = requireProvider("anthropic");
      const hint = provider.buildAuthDoctorHint?.({
        provider: "anthropic",
        profileId: "anthropic:default",
        config: {
          auth: {
            profiles: {
              "anthropic:default": {
                provider: "anthropic",
                mode: "oauth",
              },
            },
          },
        } as never,
        store: {
          version: 1,
          profiles: {
            "anthropic:oauth-user@example.com": {
              type: "oauth",
              provider: "anthropic",
              access: "oauth-access",
              refresh: "oauth-refresh",
              expires: Date.now() + 60_000,
            },
          },
        },
      });

      expect(hint).toContain("suggested profile: anthropic:oauth-user@example.com");
      expect(hint).toContain("openclaw doctor --yes");
    });

    it("owns usage snapshot fetching", async () => {
      const provider = requireProvider("anthropic");
      const mockFetch = createProviderUsageFetch(async (url) => {
        if (url.includes("api.anthropic.com/api/oauth/usage")) {
          return makeResponse(200, {
            five_hour: { utilization: 20, resets_at: "2026-01-07T01:00:00Z" },
            seven_day: { utilization: 35, resets_at: "2026-01-09T01:00:00Z" },
          });
        }
        return makeResponse(404, "not found");
      });

      await expect(
        provider.fetchUsageSnapshot?.({
          config: {} as never,
          env: {} as NodeJS.ProcessEnv,
          provider: "anthropic",
          token: "anthropic-oauth-token",
          timeoutMs: 5_000,
          fetchFn: mockFetch as unknown as typeof fetch,
        }),
      ).resolves.toEqual({
        provider: "anthropic",
        displayName: "Claude",
        windows: [
          { label: "5h", usedPercent: 20, resetAt: Date.parse("2026-01-07T01:00:00Z") },
          { label: "Week", usedPercent: 35, resetAt: Date.parse("2026-01-09T01:00:00Z") },
        ],
      });
    });
  });

  describe("github-copilot", () => {
    it("owns Copilot-specific forward-compat fallbacks", () => {
      const provider = requireProvider("github-copilot");
      const model = provider.resolveDynamicModel?.({
        provider: "github-copilot",
        modelId: "gpt-5.3-codex",
        modelRegistry: {
          find: (_provider: string, id: string) =>
            id === "gpt-5.2-codex"
              ? createModel({
                  id,
                  api: "openai-codex-responses",
                  provider: "github-copilot",
                  baseUrl: "https://api.copilot.example",
                })
              : null,
        } as never,
      });

      expect(model).toMatchObject({
        id: "gpt-5.3-codex",
        provider: "github-copilot",
        api: "openai-codex-responses",
      });
    });
  });

  describe("google", () => {
    it("owns google direct gemini 3.1 forward-compat resolution", () => {
      const provider = requireProvider("google");
      const model = provider.resolveDynamicModel?.({
        provider: "google",
        modelId: "gemini-3.1-pro-preview",
        modelRegistry: {
          find: (_provider: string, id: string) =>
            id === "gemini-3-pro-preview"
              ? createModel({
                  id,
                  api: "google-generative-ai",
                  provider: "google",
                  baseUrl: "https://generativelanguage.googleapis.com",
                  reasoning: false,
                  contextWindow: 1_048_576,
                  maxTokens: 65_536,
                })
              : null,
        } as never,
      });

      expect(model).toMatchObject({
        id: "gemini-3.1-pro-preview",
        provider: "google",
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com",
        reasoning: true,
      });
    });
  });

  describe("google-gemini-cli", () => {
    it("owns gemini cli 3.1 forward-compat resolution", () => {
      const provider = requireProvider("google-gemini-cli");
      const model = provider.resolveDynamicModel?.({
        provider: "google-gemini-cli",
        modelId: "gemini-3.1-pro-preview",
        modelRegistry: {
          find: (_provider: string, id: string) =>
            id === "gemini-3-pro-preview"
              ? createModel({
                  id,
                  api: "google-gemini-cli",
                  provider: "google-gemini-cli",
                  baseUrl: "https://cloudcode-pa.googleapis.com",
                  reasoning: false,
                  contextWindow: 1_048_576,
                  maxTokens: 65_536,
                })
              : null,
        } as never,
      });

      expect(model).toMatchObject({
        id: "gemini-3.1-pro-preview",
        provider: "google-gemini-cli",
        reasoning: true,
      });
    });

    it("owns usage-token parsing", async () => {
      const provider = requireProvider("google-gemini-cli");
      await expect(
        provider.resolveUsageAuth?.({
          config: {} as never,
          env: {} as NodeJS.ProcessEnv,
          provider: "google-gemini-cli",
          resolveApiKeyFromConfigAndStore: () => undefined,
          resolveOAuthToken: async () => ({
            token: '{"token":"google-oauth-token"}',
            accountId: "google-account",
          }),
        }),
      ).resolves.toEqual({
        token: "google-oauth-token",
        accountId: "google-account",
      });
    });

    it("owns OAuth auth-profile formatting", () => {
      const provider = requireProvider("google-gemini-cli");

      expect(
        provider.formatApiKey?.({
          type: "oauth",
          provider: "google-gemini-cli",
          access: "google-oauth-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
          projectId: "proj-123",
        }),
      ).toBe('{"token":"google-oauth-token","projectId":"proj-123"}');
    });

    it("owns usage snapshot fetching", async () => {
      const provider = requireProvider("google-gemini-cli");
      const mockFetch = createProviderUsageFetch(async (url) => {
        if (url.includes("cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota")) {
          return makeResponse(200, {
            buckets: [
              { modelId: "gemini-3.1-pro-preview", remainingFraction: 0.4 },
              { modelId: "gemini-3.1-flash-preview", remainingFraction: 0.8 },
            ],
          });
        }
        return makeResponse(404, "not found");
      });

      const snapshot = await provider.fetchUsageSnapshot?.({
        config: {} as never,
        env: {} as NodeJS.ProcessEnv,
        provider: "google-gemini-cli",
        token: "google-oauth-token",
        timeoutMs: 5_000,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(snapshot).toMatchObject({
        provider: "google-gemini-cli",
        displayName: "Gemini",
      });
      expect(snapshot?.windows[0]).toEqual({ label: "Pro", usedPercent: 60 });
      expect(snapshot?.windows[1]?.label).toBe("Flash");
      expect(snapshot?.windows[1]?.usedPercent).toBeCloseTo(20);
    });
  });

  describe("openai", () => {
    it("owns openai gpt-5.4 forward-compat resolution", () => {
      const provider = requireProvider("openai");
      const model = provider.resolveDynamicModel?.({
        provider: "openai",
        modelId: "gpt-5.4-pro",
        modelRegistry: {
          find: (_provider: string, id: string) =>
            id === "gpt-5.2-pro"
              ? createModel({
                  id,
                  provider: "openai",
                  baseUrl: "https://api.openai.com/v1",
                  input: ["text", "image"],
                })
              : null,
        } as never,
      });

      expect(model).toMatchObject({
        id: "gpt-5.4-pro",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      });
    });

    it("owns direct openai transport normalization", () => {
      const provider = requireProvider("openai");
      expect(
        provider.normalizeResolvedModel?.({
          provider: "openai",
          modelId: "gpt-5.4",
          model: createModel({
            id: "gpt-5.4",
            provider: "openai",
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
            input: ["text", "image"],
            contextWindow: 1_050_000,
            maxTokens: 128_000,
          }),
        }),
      ).toMatchObject({
        api: "openai-responses",
      });
    });

    it("owns codex-only missing-auth hints and Spark suppression", () => {
      const provider = requireProvider("openai");
      expect(
        provider.buildMissingAuthMessage?.({
          env: {} as NodeJS.ProcessEnv,
          provider: "openai",
          listProfileIds: (providerId) => (providerId === "openai-codex" ? ["p1"] : []),
        }),
      ).toContain("openai-codex/gpt-5.4");
      expect(
        provider.suppressBuiltInModel?.({
          env: {} as NodeJS.ProcessEnv,
          provider: "azure-openai-responses",
          modelId: "gpt-5.3-codex-spark",
        }),
      ).toMatchObject({
        suppress: true,
      });
    });
  });

  describe("openai-codex", () => {
    it("owns refresh fallback for accountId extraction failures", async () => {
      const provider = requireProvider("openai-codex");
      const credential = {
        type: "oauth" as const,
        provider: "openai-codex",
        access: "cached-access-token",
        refresh: "refresh-token",
        expires: Date.now() - 60_000,
      };

      getOAuthApiKeyMock.mockReset();
      getOAuthApiKeyMock.mockRejectedValueOnce(new Error("Failed to extract accountId from token"));

      await expect(provider.refreshOAuth?.(credential)).resolves.toEqual(credential);
    });

    it("owns forward-compat codex models", () => {
      const provider = requireProvider("openai-codex");
      const model = provider.resolveDynamicModel?.({
        provider: "openai-codex",
        modelId: "gpt-5.4",
        modelRegistry: {
          find: (_provider: string, id: string) =>
            id === "gpt-5.2-codex"
              ? createModel({
                  id,
                  api: "openai-codex-responses",
                  provider: "openai-codex",
                  baseUrl: "https://chatgpt.com/backend-api",
                })
              : null,
        } as never,
      });

      expect(model).toMatchObject({
        id: "gpt-5.4",
        provider: "openai-codex",
        api: "openai-codex-responses",
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      });
    });

    it("owns codex transport defaults", () => {
      const provider = requireProvider("openai-codex");
      expect(
        provider.prepareExtraParams?.({
          provider: "openai-codex",
          modelId: "gpt-5.4",
          extraParams: { temperature: 0.2 },
        }),
      ).toEqual({
        temperature: 0.2,
        transport: "auto",
      });
    });

    it("owns usage snapshot fetching", async () => {
      const provider = requireProvider("openai-codex");
      const mockFetch = createProviderUsageFetch(async (url) => {
        if (url.includes("chatgpt.com/backend-api/wham/usage")) {
          return makeResponse(200, {
            rate_limit: {
              primary_window: {
                used_percent: 12,
                limit_window_seconds: 10800,
                reset_at: 1_705_000,
              },
            },
            plan_type: "Plus",
          });
        }
        return makeResponse(404, "not found");
      });

      await expect(
        provider.fetchUsageSnapshot?.({
          config: {} as never,
          env: {} as NodeJS.ProcessEnv,
          provider: "openai-codex",
          token: "codex-token",
          accountId: "acc-1",
          timeoutMs: 5_000,
          fetchFn: mockFetch as unknown as typeof fetch,
        }),
      ).resolves.toEqual({
        provider: "openai-codex",
        displayName: "Codex",
        windows: [{ label: "3h", usedPercent: 12, resetAt: 1_705_000_000 }],
        plan: "Plus",
      });
    });
  });

  describe("qwen-portal", () => {
    it("owns OAuth refresh", async () => {
      const provider = requireProvider("qwen-portal");
      const credential = {
        type: "oauth" as const,
        provider: "qwen-portal",
        access: "stale-access-token",
        refresh: "refresh-token",
        expires: Date.now() - 60_000,
      };
      const refreshed = {
        ...credential,
        access: "fresh-access-token",
        expires: Date.now() + 60_000,
      };

      refreshQwenPortalCredentialsMock.mockReset();
      refreshQwenPortalCredentialsMock.mockResolvedValueOnce(refreshed);

      await expect(provider.refreshOAuth?.(credential)).resolves.toEqual(refreshed);
    });
  });

  describe("zai", () => {
    it("owns glm-5 forward-compat resolution", () => {
      const provider = requireProvider("zai");
      const model = provider.resolveDynamicModel?.({
        provider: "zai",
        modelId: "glm-5",
        modelRegistry: {
          find: (_provider: string, id: string) =>
            id === "glm-4.7"
              ? createModel({
                  id,
                  api: "openai-completions",
                  provider: "zai",
                  baseUrl: "https://api.z.ai/api/paas/v4",
                  reasoning: false,
                  contextWindow: 202_752,
                  maxTokens: 16_384,
                })
              : null,
        } as never,
      });

      expect(model).toMatchObject({
        id: "glm-5",
        provider: "zai",
        api: "openai-completions",
        reasoning: true,
      });
    });

    it("owns usage auth resolution", async () => {
      const provider = requireProvider("zai");
      await expect(
        provider.resolveUsageAuth?.({
          config: {} as never,
          env: {
            ZAI_API_KEY: "env-zai-token",
          } as NodeJS.ProcessEnv,
          provider: "zai",
          resolveApiKeyFromConfigAndStore: () => "env-zai-token",
          resolveOAuthToken: async () => null,
        }),
      ).resolves.toEqual({
        token: "env-zai-token",
      });
    });

    it("owns usage snapshot fetching", async () => {
      const provider = requireProvider("zai");
      const mockFetch = createProviderUsageFetch(async (url) => {
        if (url.includes("api.z.ai/api/monitor/usage/quota/limit")) {
          return makeResponse(200, {
            success: true,
            code: 200,
            data: {
              planName: "Pro",
              limits: [
                {
                  type: "TOKENS_LIMIT",
                  percentage: 25,
                  unit: 3,
                  number: 6,
                  nextResetTime: "2026-01-07T06:00:00Z",
                },
              ],
            },
          });
        }
        return makeResponse(404, "not found");
      });

      await expect(
        provider.fetchUsageSnapshot?.({
          config: {} as never,
          env: {} as NodeJS.ProcessEnv,
          provider: "zai",
          token: "env-zai-token",
          timeoutMs: 5_000,
          fetchFn: mockFetch as unknown as typeof fetch,
        }),
      ).resolves.toEqual({
        provider: "zai",
        displayName: "z.ai",
        windows: [{ label: "Tokens (6h)", usedPercent: 25, resetAt: 1_767_765_600_000 }],
        plan: "Pro",
      });
    });
  });
});
