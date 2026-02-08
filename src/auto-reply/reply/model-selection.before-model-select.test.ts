import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createModelSelectionState } from "./model-selection.js";

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
    { provider: "anthropic", id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
    { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
  ]),
}));

const mockRunBeforeModelSelect = vi.fn();

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({
    runBeforeModelSelect: mockRunBeforeModelSelect,
  })),
}));

const defaultProvider = "openai";
const defaultModel = "gpt-4o-mini";

const makeEntry = (overrides: Record<string, unknown> = {}) => ({
  sessionId: "session-id",
  updatedAt: Date.now(),
  ...overrides,
});

async function resolveState(params: {
  cfg: OpenClawConfig;
  sessionEntry?: ReturnType<typeof makeEntry>;
  sessionStore?: Record<string, ReturnType<typeof makeEntry>>;
  sessionKey?: string;
  prompt?: string;
}) {
  return createModelSelectionState({
    cfg: params.cfg,
    agentCfg: params.cfg.agents?.defaults,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore ?? {},
    sessionKey: params.sessionKey ?? "test-session",
    defaultProvider,
    defaultModel,
    provider: defaultProvider,
    model: defaultModel,
    hasModelDirective: false,
    prompt: params.prompt,
  });
}

describe("createModelSelectionState before_model_select hook integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunBeforeModelSelect.mockResolvedValue(undefined);
  });

  it("calls hook with correct event data", async () => {
    const cfg = {} as OpenClawConfig;

    await resolveState({ cfg, sessionKey: "test-session", prompt: "Hello world" });

    expect(mockRunBeforeModelSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: defaultProvider,
        model: defaultModel,
        sessionKey: "test-session",
        prompt: "Hello world",
      }),
      expect.objectContaining({
        sessionKey: "test-session",
      }),
    );
  });

  it("applies hook result when model is in allowlist", async () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-4o-mini": {},
            "anthropic/claude-sonnet-4-20250514": {},
          },
        },
      },
    } as OpenClawConfig;

    mockRunBeforeModelSelect.mockResolvedValue({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    });

    const state = await resolveState({ cfg });

    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-sonnet-4-20250514");
  });

  it("ignores hook result when model is NOT in allowlist", async () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-4o-mini": {},
          },
        },
      },
    } as OpenClawConfig;

    mockRunBeforeModelSelect.mockResolvedValue({
      provider: "anthropic",
      model: "claude-opus-4-5",
    });

    const state = await resolveState({ cfg });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-4o-mini");
  });

  it("applies hook result when allowlist is empty (all models allowed)", async () => {
    const cfg = {} as OpenClawConfig;

    mockRunBeforeModelSelect.mockResolvedValue({
      provider: "anthropic",
      model: "claude-opus-4-5",
    });

    const state = await resolveState({ cfg });

    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-opus-4-5");
  });

  it("keeps original selection when hook returns undefined", async () => {
    const cfg = {} as OpenClawConfig;

    mockRunBeforeModelSelect.mockResolvedValue(undefined);

    const state = await resolveState({ cfg });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-4o-mini");
  });

  it("applies partial hook result (model only, provider unchanged)", async () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-4o-mini": {},
            "openai/gpt-4o": {},
          },
        },
      },
    } as OpenClawConfig;

    mockRunBeforeModelSelect.mockResolvedValue({
      model: "gpt-4o",
    });

    const state = await resolveState({ cfg });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-4o");
  });

  it("applies hook result with both provider and model change", async () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-4o-mini": {},
            "anthropic/claude-sonnet-4-20250514": {},
          },
        },
      },
    } as OpenClawConfig;

    mockRunBeforeModelSelect.mockResolvedValue({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    });

    const state = await resolveState({ cfg });

    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-sonnet-4-20250514");
  });

  it("passes allowedModelKeys set to hook event", async () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-4o-mini": {},
            "anthropic/claude-sonnet-4-20250514": {},
          },
        },
      },
    } as OpenClawConfig;

    await resolveState({ cfg });

    expect(mockRunBeforeModelSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedModelKeys: expect.any(Set),
      }),
      expect.anything(),
    );

    const eventArg = mockRunBeforeModelSelect.mock.calls[0][0];
    expect(eventArg.allowedModelKeys.has("openai/gpt-4o-mini")).toBe(true);
    expect(eventArg.allowedModelKeys.has("anthropic/claude-sonnet-4-20250514")).toBe(true);
    expect(eventArg.allowedModelKeys.has("anthropic/claude-opus-4-5")).toBe(false);
  });
});
