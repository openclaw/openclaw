import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createModelSelectionState } from "./model-selection.js";

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { provider: "inferencer", id: "deepseek-v3-4bit-mlx", name: "DeepSeek V3" },
    { provider: "kimi-coding", id: "k2p5", name: "Kimi K2.5" },
    { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
  ]),
}));

const makeEntry = (overrides: Record<string, unknown> = {}) => ({
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

  it("inherits parent override from explicit parentSessionKey", async () => {
    const cfg = {} as OpenClawConfig;
    const parentKey = "agent:main:discord:channel:c1";
    const sessionKey = "agent:main:discord:channel:c1:thread:123";
    const parentEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
    });
    const sessionEntry = makeEntry();
    const sessionStore = {
      [parentKey]: parentEntry,
      [sessionKey]: sessionEntry,
    };

    const state = await resolveState({
      cfg,
      sessionEntry,
      sessionStore,
      sessionKey,
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
    const sessionEntry = makeEntry();
    const sessionStore = {
      [parentKey]: parentEntry,
      [sessionKey]: sessionEntry,
    };

    const state = await resolveState({
      cfg,
      sessionEntry,
      sessionStore,
      sessionKey,
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
    const sessionStore = {
      [parentKey]: parentEntry,
      [sessionKey]: sessionEntry,
    };

    const state = await resolveState({
      cfg,
      sessionEntry,
      sessionStore,
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
    const sessionEntry = makeEntry();
    const sessionStore = {
      [parentKey]: parentEntry,
      [sessionKey]: sessionEntry,
    };

    const state = await resolveState({
      cfg,
      sessionEntry,
      sessionStore,
      sessionKey,
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
        modelOverride: "k2p5",
      }),
    );

    expect(state.provider).toBe("kimi-coding");
    expect(state.model).toBe("k2p5");
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
        model: "k2p5",
        modelProvider: "kimi-coding",
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
});
