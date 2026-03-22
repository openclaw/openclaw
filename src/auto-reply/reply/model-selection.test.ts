import { describe, expect, it, vi } from "vitest";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { createModelSelectionState } from "./model-selection.js";

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { provider: "inferencer", id: "deepseek-v3-4bit-mlx", name: "DeepSeek V3" },
    { provider: "kimi", id: "kimi-code", name: "Kimi Code" },
    { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
    { provider: "xai", id: "grok-4", name: "Grok 4" },
    { provider: "xai", id: "grok-4.20-reasoning", name: "Grok 4.20 (Reasoning)" },
  ]),
}));

const makeConfiguredModel = (overrides: Record<string, unknown> = {}) => ({
  id: "gpt-5.4",
  name: "GPT-5.4",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
  ...overrides,
});

describe("createModelSelectionState catalog loading", () => {
  it("skips full catalog loading for ordinary allowlist-backed turns", async () => {
    vi.mocked(loadModelCatalog).mockClear();
    const cfg = {
      agents: {
        defaults: {
          thinkingDefault: "low",
          models: {
            "openai-codex/gpt-5.4": {},
          },
        },
      },
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://api.openai.com/v1",
            models: [makeConfiguredModel()],
          },
        },
      },
    } as OpenClawConfig;

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.4",
      provider: "openai-codex",
      model: "gpt-5.4",
      hasModelDirective: false,
    });

    expect(state.allowedModelKeys.has("openai-codex/gpt-5.4")).toBe(true);
    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("low");
    await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("on");
    expect(loadModelCatalog).not.toHaveBeenCalled();
  });

  it("prefers per-agent thinkingDefault over model and global defaults", async () => {
    vi.mocked(loadModelCatalog).mockClear();
    const cfg = {
      agents: {
        defaults: {
          thinkingDefault: "low",
          models: {
            "openai-codex/gpt-5.4": {
              params: { thinking: "high" },
            },
          },
        },
        list: [
          {
            id: "alpha",
            thinkingDefault: "minimal",
          },
        ],
      },
    } as OpenClawConfig;

    const state = await createModelSelectionState({
      cfg,
      agentId: "alpha",
      agentCfg: cfg.agents?.defaults,
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.4",
      provider: "openai-codex",
      model: "gpt-5.4",
      hasModelDirective: false,
    });

    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("minimal");
  });

  it("loads the full catalog for explicit model directives", async () => {
    vi.mocked(loadModelCatalog).mockClear();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-4o": {},
          },
        },
      },
    } as OpenClawConfig;

    await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      provider: "openai",
      model: "gpt-4o",
      hasModelDirective: true,
    });

    expect(loadModelCatalog).toHaveBeenCalledOnce();
  });
});

const makeEntry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId: "session-id",
  updatedAt: Date.now(),
  ...overrides,
});

describe("createModelSelectionState parent inheritance", () => {
  const defaultProvider = "openai";
  const defaultModel = "gpt-4o-mini";

  async function resolveState(params: {
    cfg: OpenClawConfig;
    sessionEntry: ReturnType<typeof makeEntry>;
    sessionStore: Record<string, ReturnType<typeof makeEntry>>;
    sessionKey: string;
    parentSessionKey?: string;
  }) {
    return createModelSelectionState({
      cfg: params.cfg,
      agentCfg: params.cfg.agents?.defaults,
      sessionEntry: params.sessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      parentSessionKey: params.parentSessionKey,
      defaultProvider,
      defaultModel,
      provider: defaultProvider,
      model: defaultModel,
      hasModelDirective: false,
    });
  }

  async function resolveHeartbeatStoredOverrideState(hasResolvedHeartbeatModelOverride: boolean) {
    const cfg = {} as OpenClawConfig;
    const sessionKey = "agent:main:discord:channel:c1";
    const sessionEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    return createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider,
      defaultModel,
      provider: "anthropic",
      model: "claude-opus-4-5",
      hasModelDirective: false,
      hasResolvedHeartbeatModelOverride,
    });
  }

  async function resolveStateWithParent(params: {
    cfg: OpenClawConfig;
    parentKey: string;
    sessionKey: string;
    parentEntry: ReturnType<typeof makeEntry>;
    sessionEntry?: ReturnType<typeof makeEntry>;
    parentSessionKey?: string;
  }) {
    const sessionEntry = params.sessionEntry ?? makeEntry();
    const sessionStore = {
      [params.parentKey]: params.parentEntry,
      [params.sessionKey]: sessionEntry,
    };
    return resolveState({
      cfg: params.cfg,
      sessionEntry,
      sessionStore,
      sessionKey: params.sessionKey,
      parentSessionKey: params.parentSessionKey,
    });
  }

  it("inherits parent override from explicit parentSessionKey", async () => {
    const cfg = {} as OpenClawConfig;
    const parentKey = "agent:main:discord:channel:c1";
    const sessionKey = "agent:main:discord:channel:c1:thread:123";
    const parentEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
    });
    const state = await resolveStateWithParent({
      cfg,
      parentKey,
      sessionKey,
      parentEntry,
      parentSessionKey: parentKey,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-4o");
  });

  it("derives parent key from topic session suffix", async () => {
    const cfg = {} as OpenClawConfig;
    const parentKey = "agent:main:telegram:group:123";
    const sessionKey = "agent:main:telegram:group:123:topic:99";
    const parentEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
    });
    const state = await resolveStateWithParent({
      cfg,
      parentKey,
      sessionKey,
      parentEntry,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-4o");
  });

  it("prefers child override over parent", async () => {
    const cfg = {} as OpenClawConfig;
    const parentKey = "agent:main:telegram:group:123";
    const sessionKey = "agent:main:telegram:group:123:topic:99";
    const parentEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
    });
    const sessionEntry = makeEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-5",
    });
    const state = await resolveStateWithParent({
      cfg,
      parentKey,
      parentEntry,
      sessionEntry,
      sessionKey,
    });

    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-opus-4-5");
  });

  it("ignores parent override when disallowed", async () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-4o-mini": {},
          },
        },
      },
    } as OpenClawConfig;
    const parentKey = "agent:main:slack:channel:c1";
    const sessionKey = "agent:main:slack:channel:c1:thread:123";
    const parentEntry = makeEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-5",
    });
    const state = await resolveStateWithParent({
      cfg,
      parentKey,
      sessionKey,
      parentEntry,
    });

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe(defaultModel);
  });

  it("applies stored override when heartbeat override was not resolved", async () => {
    const state = await resolveHeartbeatStoredOverrideState(false);

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-4o");
  });

  it("skips stored override when heartbeat override was resolved", async () => {
    const state = await resolveHeartbeatStoredOverrideState(true);

    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-opus-4-5");
  });
});

describe("createModelSelectionState respects session model override", () => {
  const defaultProvider = "inferencer";
  const defaultModel = "deepseek-v3-4bit-mlx";

  async function resolveState(sessionEntry: ReturnType<typeof makeEntry>) {
    const cfg = {} as OpenClawConfig;
    const sessionKey = "agent:main:main";
    const sessionStore = { [sessionKey]: sessionEntry };

    return createModelSelectionState({
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
  }

  it("applies session modelOverride when set", async () => {
    const state = await resolveState(
      makeEntry({
        providerOverride: "kimi-coding",
        modelOverride: "kimi-code",
      }),
    );

    expect(state.provider).toBe("kimi");
    expect(state.model).toBe("kimi-code");
  });

  it("falls back to default when no modelOverride is set", async () => {
    const state = await resolveState(makeEntry());

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe(defaultModel);
  });

  it("respects modelOverride even when session model field differs", async () => {
    // From issue #14783: stored override should beat last-used fallback model.
    const state = await resolveState(
      makeEntry({
        model: "kimi-code",
        modelProvider: "kimi",
        contextTokens: 262_000,
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-5",
      }),
    );

    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-opus-4-5");
  });

  it("uses default provider when providerOverride is not set but modelOverride is", async () => {
    const state = await resolveState(
      makeEntry({
        modelOverride: "deepseek-v3-4bit-mlx",
      }),
    );

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe("deepseek-v3-4bit-mlx");
  });

  it("normalizes deprecated xai beta session overrides before allowlist checks", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "xai/grok-4",
          },
          models: {
            "xai/grok-4": {},
            "xai/grok-4.20-experimental-beta-0304-reasoning": {},
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:telegram:group:123:topic:99";
    const sessionEntry = makeEntry({
      providerOverride: "xai",
      modelOverride: "grok-4.20-experimental-beta-0304-reasoning",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "xai",
      defaultModel: "grok-4",
      provider: "xai",
      model: "grok-4",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("xai");
    expect(state.model).toBe("grok-4.20-reasoning");
    expect(state.resetModelOverride).toBe(false);
  });

  it("clears disallowed model overrides and falls back to the default", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-4o" },
          models: {
            "openai/gpt-4o": {},
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:telegram:direct:1";
    const sessionEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o-mini",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      provider: "openai",
      model: "gpt-4o",
      hasModelDirective: false,
    });

    expect(state.resetModelOverride).toBe(true);
    expect(sessionStore[sessionKey]?.modelOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
  });
});

describe("createModelSelectionState resolveDefaultReasoningLevel", () => {
  it("returns on when catalog model has reasoning true", async () => {
    const { loadModelCatalog } = await import("../../agents/model-catalog.js");
    vi.mocked(loadModelCatalog).mockResolvedValueOnce([
      { provider: "openrouter", id: "x-ai/grok-4.1-fast", name: "Grok", reasoning: true },
    ]);
    const state = await createModelSelectionState({
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      defaultProvider: "openrouter",
      defaultModel: "x-ai/grok-4.1-fast",
      provider: "openrouter",
      model: "x-ai/grok-4.1-fast",
      hasModelDirective: false,
    });
    await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("on");
  });

  it("returns off when catalog model has no reasoning", async () => {
    const state = await createModelSelectionState({
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      provider: "openai",
      model: "gpt-4o-mini",
      hasModelDirective: false,
    });
    await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("off");
  });
});
