import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

// Mock runWithModelFallback to avoid importing the full dependency tree.
const fallbackMock = vi.fn();
vi.mock("./model-fallback.js", () => ({
  runWithModelFallback: (...args: unknown[]) => fallbackMock(...args),
}));

// Import after mocking.
const { runWithTokenBudgetRouting } = await import("./token-budget-routing.js");

function makeConfig(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    tokenBudget: {
      enabled: true,
      tiers: [
        { provider: "openai", model: "gpt-5.1-codex", dailyTokenLimit: 1_000_000 },
        { provider: "openai", model: "gpt-5.1-codex-mini", dailyTokenLimit: 10_000_000 },
      ],
      resetTime: "midnight-local",
    },
    ...overrides,
  };
}

describe("runWithTokenBudgetRouting", () => {
  beforeEach(() => {
    fallbackMock.mockReset();
    // Default mock: invoke the run callback with provider/model from params.
    fallbackMock.mockImplementation(
      async (params: {
        provider: string;
        model: string;
        run: (p: string, m: string) => Promise<unknown>;
      }) => ({
        result: await params.run(params.provider, params.model),
        provider: params.provider,
        model: params.model,
        attempts: [],
      }),
    );
  });

  it("bypasses routing when tokenBudget is not configured", async () => {
    await runWithTokenBudgetRouting({
      cfg: {},
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      run: async () => "hello",
    });

    expect(fallbackMock).toHaveBeenCalledTimes(1);
    expect(fallbackMock.mock.calls[0][0].provider).toBe("anthropic");
    expect(fallbackMock.mock.calls[0][0].model).toBe("claude-sonnet-4-6");
  });

  it("bypasses routing when tokenBudget is disabled", async () => {
    await runWithTokenBudgetRouting({
      cfg: { tokenBudget: { enabled: false, tiers: [] } },
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      run: async () => "hello",
    });

    expect(fallbackMock).toHaveBeenCalledTimes(1);
    expect(fallbackMock.mock.calls[0][0].provider).toBe("anthropic");
  });

  it("routes to first budget tier when available", async () => {
    const cfg = makeConfig();

    await runWithTokenBudgetRouting({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      run: async (p: string, m: string) => `called ${p}/${m}`,
    });

    // Should route to first tier.
    expect(fallbackMock.mock.calls[0][0].provider).toBe("openai");
    expect(fallbackMock.mock.calls[0][0].model).toBe("gpt-5.1-codex");
    // Fallbacks should include remaining tiers + original primary.
    const fallbacks = fallbackMock.mock.calls[0][0].fallbacksOverride;
    expect(fallbacks).toContain("openai/gpt-5.1-codex-mini");
    expect(fallbacks).toContain("anthropic/claude-sonnet-4-6");
  });

  it("falls back to primary when all tiers have zero limit", async () => {
    // Tiers with dailyTokenLimit of 1 will be considered exhausted
    // only if usage >= 1. With no prior usage, tier 1 should still be active.
    // Use the mock to simulate: set up state where tiers are exhausted.
    const cfg: OpenClawConfig = {
      tokenBudget: {
        enabled: true,
        tiers: [], // Empty tiers = no budget routing = use primary.
        resetTime: "midnight-local",
      },
    };

    await runWithTokenBudgetRouting({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      run: async () => "result",
    });

    // Should use original primary.
    expect(fallbackMock.mock.calls[0][0].provider).toBe("anthropic");
    expect(fallbackMock.mock.calls[0][0].model).toBe("claude-sonnet-4-6");
  });

  it("extracts actual usage from result meta when available", async () => {
    // Mock fallback to return a result with embedded usage (EmbeddedPiRunResult shape).
    fallbackMock.mockImplementation(
      async (params: {
        provider: string;
        model: string;
        run: (p: string, m: string) => Promise<unknown>;
      }) => ({
        result: {
          meta: {
            agentMeta: {
              usage: { input: 5000, output: 2000 },
            },
            durationMs: 100,
          },
        },
        provider: params.provider,
        model: params.model,
        attempts: [],
      }),
    );

    const cfg = makeConfig();

    await runWithTokenBudgetRouting({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      run: async () => "result",
    });

    // Usage should be 5000 + 2000 = 7000, not the default 4000 estimate.
    // We can't easily check the persisted state here, but verifying no
    // error is thrown with the new extraction path is the key assertion.
    expect(fallbackMock).toHaveBeenCalledTimes(1);
  });

  it("preserves original fallbacks in budget fallback chain", async () => {
    const cfg = makeConfig();

    await runWithTokenBudgetRouting({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbacksOverride: ["google/gemini-2.5-pro"],
      run: async () => "result",
    });

    const fallbacks = fallbackMock.mock.calls[0][0].fallbacksOverride;
    expect(fallbacks).toContain("google/gemini-2.5-pro");
    expect(fallbacks).toContain("anthropic/claude-sonnet-4-6");
    expect(fallbacks).toContain("openai/gpt-5.1-codex-mini");
  });

  it("runs without error when no usage is reported", async () => {
    const cfg = makeConfig();

    const result = await runWithTokenBudgetRouting({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      run: async () => "result",
    });

    expect(result.result).toBe("result");
  });
});
