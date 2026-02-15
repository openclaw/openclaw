import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createModelSelectionState } from "./model-selection.js";

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { provider: "inferencer", id: "deepseek-v3-4bit-mlx", name: "DeepSeek V3" },
    { provider: "kimi-coding", id: "k2p5", name: "Kimi K2.5" },
    { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
  ]),
}));

const defaultProvider = "inferencer";
const defaultModel = "deepseek-v3-4bit-mlx";

const makeEntry = (overrides: Record<string, unknown> = {}) => ({
  sessionId: "session-id",
  updatedAt: Date.now(),
  ...overrides,
});

describe("createModelSelectionState respects session model override", () => {
  it("applies session modelOverride when set", async () => {
    const cfg = {} as OpenClawConfig;
    const sessionKey = "agent:main:main";
    const sessionEntry = makeEntry({
      providerOverride: "kimi-coding",
      modelOverride: "k2p5",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      cfg,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider,
      defaultModel,
      provider: defaultProvider,
      model: defaultModel,
      hasModelDirective: false,
    });

    expect(state.provider).toBe("kimi-coding");
    expect(state.model).toBe("k2p5");
  });

  it("falls back to default when no modelOverride is set", async () => {
    const cfg = {} as OpenClawConfig;
    const sessionKey = "agent:main:main";
    const sessionEntry = makeEntry();
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      cfg,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider,
      defaultModel,
      provider: defaultProvider,
      model: defaultModel,
      hasModelDirective: false,
    });

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe(defaultModel);
  });

  it("respects modelOverride even when session model field differs", async () => {
    // This tests the scenario from issue #14783: user switches model via /model,
    // the override is stored, but session.model still reflects the last-used
    // fallback model. The override should take precedence.
    const cfg = {} as OpenClawConfig;
    const sessionKey = "agent:main:main";
    const sessionEntry = makeEntry({
      // Last-used model (from fallback) - should NOT be used for selection
      model: "k2p5",
      modelProvider: "kimi-coding",
      contextTokens: 262_000,
      // User's explicit override - SHOULD be used
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-5",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      cfg,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider,
      defaultModel,
      provider: defaultProvider,
      model: defaultModel,
      hasModelDirective: false,
    });

    // Should use the override, not the last-used model
    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-opus-4-5");
  });

  it("uses default provider when providerOverride is not set but modelOverride is", async () => {
    const cfg = {} as OpenClawConfig;
    const sessionKey = "agent:main:main";
    const sessionEntry = makeEntry({
      modelOverride: "deepseek-v3-4bit-mlx",
      // no providerOverride
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      cfg,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider,
      defaultModel,
      provider: defaultProvider,
      model: defaultModel,
      hasModelDirective: false,
    });

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe("deepseek-v3-4bit-mlx");
  });
});
