import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";

// Mock loadModelCatalog to return a small built-in catalog (no custom providers).
vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
  ]),
}));

vi.mock("../../config/sessions.js", () => ({
  updateSessionStore: vi.fn(async () => {}),
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: vi.fn(() => ({ profiles: {} })),
}));

vi.mock("../../agents/auth-profiles/session-override.js", () => ({
  clearSessionAuthProfileOverride: vi.fn(async () => {}),
}));

import { updateSessionStore } from "../../config/sessions.js";
import { createModelSelectionState } from "./model-selection.js";

const updateSessionStoreMock = vi.mocked(updateSessionStore);

describe("createModelSelectionState: allowAny with custom providers (#2144)", () => {
  beforeEach(() => updateSessionStoreMock.mockClear());
  const baseCfg: OpenClawConfig = {
    models: {
      providers: {
        deepseek: {
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "FAKE",
          api: "openai-completions",
          models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
        },
      },
    },
    // No agents.defaults.models allowlist → allowAny = true
  } as unknown as OpenClawConfig;

  const defaultProvider = "anthropic";
  const defaultModel = "claude-opus-4-5";

  it("preserves custom provider model override when allowAny is true", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "sub-1",
      updatedAt: Date.now(),
      providerOverride: "deepseek",
      modelOverride: "deepseek-chat",
    };
    const sessionStore: Record<string, SessionEntry> = {
      "agent:main:subagent:sub-1": sessionEntry,
    };

    const state = await createModelSelectionState({
      cfg: baseCfg,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:subagent:sub-1",
      defaultProvider,
      defaultModel,
      provider: defaultProvider,
      model: defaultModel,
      hasModelDirective: false,
    });

    // The override should be applied, NOT silently reset
    expect(state.provider).toBe("deepseek");
    expect(state.model).toBe("deepseek-chat");
    expect(state.resetModelOverride).toBe(false);
    // Session entry should NOT have been mutated
    expect(sessionEntry.providerOverride).toBe("deepseek");
    expect(sessionEntry.modelOverride).toBe("deepseek-chat");
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it("preserves OpenRouter model override when allowAny is true", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "sub-2",
      updatedAt: Date.now(),
      providerOverride: "openrouter",
      modelOverride: "google/gemini-2.5-flash",
    };
    const sessionStore: Record<string, SessionEntry> = {
      "agent:main:subagent:sub-2": sessionEntry,
    };

    const state = await createModelSelectionState({
      cfg: baseCfg,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:subagent:sub-2",
      defaultProvider,
      defaultModel,
      provider: defaultProvider,
      model: defaultModel,
      hasModelDirective: false,
    });

    expect(state.provider).toBe("openrouter");
    expect(state.model).toBe("google/gemini-2.5-flash");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionEntry.providerOverride).toBe("openrouter");
    expect(sessionEntry.modelOverride).toBe("google/gemini-2.5-flash");
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it("still allows built-in Anthropic model overrides", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "sub-3",
      updatedAt: Date.now(),
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-5",
    };
    const sessionStore: Record<string, SessionEntry> = {
      "agent:main:subagent:sub-3": sessionEntry,
    };

    const state = await createModelSelectionState({
      cfg: baseCfg,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:subagent:sub-3",
      defaultProvider,
      defaultModel,
      provider: defaultProvider,
      model: defaultModel,
      hasModelDirective: false,
    });

    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-sonnet-4-5");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionEntry.providerOverride).toBe("anthropic");
    expect(sessionEntry.modelOverride).toBe("claude-sonnet-4-5");
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it("still rejects models not in allowlist when allowlist is configured", async () => {
    const cfgWithAllowlist: OpenClawConfig = {
      ...baseCfg,
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-5": {},
            "anthropic/claude-sonnet-4-5": {},
            // DeepSeek NOT in allowlist
          },
        },
      },
    } as unknown as OpenClawConfig;

    const sessionEntry: SessionEntry = {
      sessionId: "sub-4",
      updatedAt: Date.now(),
      providerOverride: "deepseek",
      modelOverride: "deepseek-chat",
    };
    const sessionStore: Record<string, SessionEntry> = {
      "agent:main:subagent:sub-4": sessionEntry,
    };

    const state = await createModelSelectionState({
      cfg: cfgWithAllowlist,
      agentCfg: cfgWithAllowlist.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:subagent:sub-4",
      storePath: undefined,
      defaultProvider,
      defaultModel,
      provider: defaultProvider,
      model: defaultModel,
      hasModelDirective: false,
    });

    // Should reset to default because DeepSeek is NOT in the explicit allowlist
    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe(defaultModel);
    expect(state.resetModelOverride).toBe(true);
    // Session entry should have been mutated: override fields deleted
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionEntry.providerOverride).toBeUndefined();
  });
});
