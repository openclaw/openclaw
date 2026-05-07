import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import { modelSelectionMockFns } from "./get-reply.test-mocks.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  initSessionState: vi.fn(),
}));

vi.mock("./get-reply-directives.js", () => ({
  resolveReplyDirectives: (...args: unknown[]) => mocks.resolveReplyDirectives(...args),
}));

vi.mock("./session.js", () => ({
  initSessionState: (...args: unknown[]) => mocks.initSessionState(...args),
}));

vi.mock("./message-preprocess-hooks.js", () => ({
  emitPreAgentMessageHooks: vi.fn(() => undefined),
}));

const channelOverrideMocks = vi.hoisted(() => ({
  resolveChannelModelOverride: vi.fn(() => undefined),
}));
vi.mock("../../channels/model-overrides.js", () => ({
  resolveChannelModelOverride: channelOverrideMocks.resolveChannelModelOverride,
}));

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
let defaultRuntime: typeof import("../../runtime.js").defaultRuntime;

async function loadGetReplyRuntimeForTest() {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  ({ defaultRuntime } = await import("../../runtime.js"));
}

function buildCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    Provider: "telegram",
    Surface: "telegram",
    ChatType: "direct",
    Body: "hello",
    BodyForAgent: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    SessionKey: "agent:main:telegram:123",
    From: "telegram:user:42",
    To: "telegram:123",
    Timestamp: 1710000000000,
    ...overrides,
  };
}

function buildCfg(allowlistModels?: string[]): OpenClawConfig {
  if (!allowlistModels || allowlistModels.length === 0) {
    return {} as OpenClawConfig;
  }
  const models: Record<string, object> = {};
  for (const m of allowlistModels) {
    models[m] = {};
  }
  return {
    agents: {
      defaults: {
        models,
      },
    },
  } as OpenClawConfig;
}

describe("getReplyFromConfig image model override", () => {
  beforeEach(async () => {
    await loadGetReplyRuntimeForTest();
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");

    mocks.resolveReplyDirectives.mockReset();
    mocks.initSessionState.mockReset();
    modelSelectionMockFns.resolveModelRefFromString.mockReset();

    mocks.initSessionState.mockResolvedValue({
      sessionCtx: {},
      sessionEntry: {},
      previousSessionEntry: {},
      sessionStore: {},
      sessionKey: "agent:main:telegram:123",
      sessionId: "session-1",
      isNewSession: false,
      resetTriggered: false,
      systemSent: false,
      abortedLastRun: false,
      storePath: "/tmp/sessions.json",
      sessionScope: "per-chat",
      groupResolution: undefined,
      isGroup: false,
      triggerBodyNormalized: "",
      bodyStripped: "",
    });
    mocks.resolveReplyDirectives.mockResolvedValue({
      kind: "reply" as const,
      reply: { text: "ok" },
    });

    modelSelectionMockFns.resolveModelRefFromString.mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    defaultRuntime.log.mockClear();
  });

  it("applies modelOverride when no allowlist is configured", async () => {
    modelSelectionMockFns.resolveModelRefFromString.mockImplementation(
      (params: { raw: string }) => {
        if (params.raw === "openai/gpt-4o") {
          return { ref: { provider: "openai", model: "gpt-4o" }, alias: false };
        }
        return null;
      },
    );

    await getReplyFromConfig(buildCtx(), {
      modelOverride: "openai/gpt-4o",
    });

    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4o",
        hasAppliedImageModelOverride: true,
      }),
    );
  });

  it("applies modelOverride when it is in the agent allowlist", async () => {
    modelSelectionMockFns.resolveModelRefFromString.mockImplementation(
      (params: { raw: string }) => {
        if (params.raw === "openai/gpt-4o") {
          return { ref: { provider: "openai", model: "gpt-4o" }, alias: false };
        }
        return null;
      },
    );

    await getReplyFromConfig(
      buildCtx(),
      {
        modelOverride: "openai/gpt-4o",
      },
      buildCfg(["openai/gpt-4o"]),
    );

    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4o",
        hasAppliedImageModelOverride: true,
      }),
    );
  });

  it("falls back to allowlisted fallback when primary modelOverride is blocked", async () => {
    modelSelectionMockFns.resolveModelRefFromString.mockImplementation(
      (params: { raw: string }) => {
        if (params.raw === "anthropic/claude-opus-4-6") {
          return { ref: { provider: "anthropic", model: "claude-opus-4-6" }, alias: false };
        }
        if (params.raw === "openai/gpt-4o") {
          return { ref: { provider: "openai", model: "gpt-4o" }, alias: false };
        }
        return null;
      },
    );

    await getReplyFromConfig(
      buildCtx(),
      {
        modelOverride: "anthropic/claude-opus-4-6",
        modelOverrideFallbacks: ["openai/gpt-4o"],
      },
      buildCfg(["openai/gpt-4o"]),
    );

    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4o",
        hasAppliedImageModelOverride: true,
      }),
    );
  });

  it("skips modelOverride and uses default model when blocked by allowlist with no fallback", async () => {
    modelSelectionMockFns.resolveModelRefFromString.mockImplementation(
      (params: { raw: string }) => {
        if (params.raw === "anthropic/claude-opus-4-6") {
          return { ref: { provider: "anthropic", model: "claude-opus-4-6" }, alias: false };
        }
        return null;
      },
    );

    await getReplyFromConfig(
      buildCtx(),
      {
        modelOverride: "anthropic/claude-opus-4-6",
      },
      buildCfg(["openai/gpt-4o-mini"]),
    );

    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4o-mini",
        hasAppliedImageModelOverride: false,
      }),
    );
    expect(defaultRuntime.log).toHaveBeenCalledWith(
      expect.stringContaining("not in agent allowlist and no fallback available"),
    );
  });

  it("logs image warning when modelOverride is skipped and images are present", async () => {
    modelSelectionMockFns.resolveModelRefFromString.mockImplementation(
      (params: { raw: string }) => {
        if (params.raw === "anthropic/claude-opus-4-6") {
          return { ref: { provider: "anthropic", model: "claude-opus-4-6" }, alias: false };
        }
        return null;
      },
    );

    await getReplyFromConfig(
      buildCtx(),
      {
        modelOverride: "anthropic/claude-opus-4-6",
        images: [{ type: "image", data: "abc", mimeType: "image/png" }],
      },
      buildCfg(["openai/gpt-4o-mini"]),
    );

    expect(defaultRuntime.log).toHaveBeenCalledWith(
      expect.stringContaining("WARNING: Images are present but the default model"),
    );
  });

  it("falls back to default model when modelOverride alias resolution fails", async () => {
    modelSelectionMockFns.resolveModelRefFromString.mockReturnValue(null);

    await getReplyFromConfig(buildCtx(), {
      modelOverride: "nonexistent-alias",
    });

    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4o-mini",
        hasAppliedImageModelOverride: false,
      }),
    );
    expect(defaultRuntime.log).toHaveBeenCalledWith(
      expect.stringContaining("Failed to resolve modelOverride"),
    );
  });

  it("logs image warning when modelOverride resolution fails and images are present", async () => {
    modelSelectionMockFns.resolveModelRefFromString.mockReturnValue(null);

    await getReplyFromConfig(buildCtx(), {
      modelOverride: "nonexistent-alias",
      images: [{ type: "image", data: "abc", mimeType: "image/png" }],
    });

    expect(defaultRuntime.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "WARNING: Images are present but modelOverride could not be resolved",
      ),
    );
  });

  it("resolves cross-provider fallbacks using the override provider context", async () => {
    modelSelectionMockFns.resolveModelRefFromString.mockImplementation(
      (params: { raw: string }) => {
        if (params.raw === "openai/gpt-4o") {
          return { ref: { provider: "openai", model: "gpt-4o" }, alias: false };
        }
        if (params.raw === "gpt-4o-mini") {
          return { ref: { provider: "openai", model: "gpt-4o-mini" }, alias: false };
        }
        return null;
      },
    );

    await getReplyFromConfig(
      buildCtx(),
      {
        modelOverride: "openai/gpt-4o",
        modelOverrideFallbacks: ["gpt-4o-mini"],
      },
      buildCfg(["openai/gpt-4o-mini"]),
    );

    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4o-mini",
        hasAppliedImageModelOverride: true,
      }),
    );
  });

  it("does not let stored session override clobber image model override", async () => {
    modelSelectionMockFns.resolveModelRefFromString.mockImplementation(
      (params: { raw: string }) => {
        if (params.raw === "openai/gpt-4o") {
          return { ref: { provider: "openai", model: "gpt-4o" }, alias: false };
        }
        return null;
      },
    );

    // Simulate a session with a previously stored model override
    mocks.initSessionState.mockReset();
    mocks.initSessionState.mockResolvedValue({
      sessionCtx: {},
      sessionEntry: {
        modelOverride: "anthropic/claude-sonnet-4-6",
      },
      previousSessionEntry: {},
      sessionStore: {},
      sessionKey: "agent:main:telegram:123",
      sessionId: "session-1",
      isNewSession: false,
      resetTriggered: false,
      systemSent: false,
      abortedLastRun: false,
      storePath: "/tmp/sessions.json",
      sessionScope: "per-chat",
      groupResolution: undefined,
      isGroup: false,
      triggerBodyNormalized: "",
      bodyStripped: "",
    });

    await getReplyFromConfig(buildCtx(), {
      modelOverride: "openai/gpt-4o",
    });

    // Image model override should NOT be clobbered by stored session override
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4o",
        hasAppliedImageModelOverride: true,
      }),
    );
  });

  it("keeps image model override when channel model override is configured", async () => {
    modelSelectionMockFns.resolveModelRefFromString.mockImplementation(
      (params: { raw: string }) => {
        if (params.raw === "openai/gpt-4o") {
          return { ref: { provider: "openai", model: "gpt-4o" }, alias: false };
        }
        if (params.raw === "anthropic/claude-sonnet-4-6") {
          return { ref: { provider: "anthropic", model: "claude-sonnet-4-6" }, alias: false };
        }
        return null;
      },
    );

    // Set up channel override mock to return a channel model
    channelOverrideMocks.resolveChannelModelOverride.mockReturnValue({
      channel: "telegram",
      model: "anthropic/claude-sonnet-4-6",
      matchKey: "telegram",
    });

    // Pass a config that has channels.modelByChannel so the code path is triggered.
    // The configOverride is merged with the runtime config via applyMergePatch.
    const cfgWithChannel = {
      channels: {
        modelByChannel: {
          telegram: { model: "anthropic/claude-sonnet-4-6" },
        },
      },
    } as OpenClawConfig;

    await getReplyFromConfig(
      buildCtx(),
      {
        modelOverride: "openai/gpt-4o",
      },
      cfgWithChannel,
    );

    // Image model override should NOT be clobbered by channel model override
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4o",
        hasAppliedImageModelOverride: true,
      }),
    );

    // Reset mock for other tests
    channelOverrideMocks.resolveChannelModelOverride.mockReturnValue(undefined);
  });

  it("ignores empty modelOverride and uses default model", async () => {
    await getReplyFromConfig(buildCtx(), {
      modelOverride: "   ",
    });

    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4o-mini",
        hasAppliedImageModelOverride: false,
      }),
    );
  });

  it("ignores undefined modelOverride and uses default model", async () => {
    await getReplyFromConfig(buildCtx(), {});

    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4o-mini",
        hasAppliedImageModelOverride: false,
      }),
    );
  });

  it("tries multiple fallbacks in order when primary is blocked", async () => {
    modelSelectionMockFns.resolveModelRefFromString.mockImplementation(
      (params: { raw: string }) => {
        if (params.raw === "anthropic/claude-opus-4-6") {
          return { ref: { provider: "anthropic", model: "claude-opus-4-6" }, alias: false };
        }
        if (params.raw === "openai/gpt-4o") {
          return { ref: { provider: "openai", model: "gpt-4o" }, alias: false };
        }
        if (params.raw === "openai/gpt-4o-mini") {
          return { ref: { provider: "openai", model: "gpt-4o-mini" }, alias: false };
        }
        return null;
      },
    );

    await getReplyFromConfig(
      buildCtx(),
      {
        modelOverride: "anthropic/claude-opus-4-6",
        modelOverrideFallbacks: ["openai/gpt-4o", "openai/gpt-4o-mini"],
      },
      buildCfg(["openai/gpt-4o"]),
    );

    // First fallback is in allowlist, should be selected
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4o",
        hasAppliedImageModelOverride: true,
      }),
    );
  });

  it("uses default model when all fallbacks are blocked by allowlist", async () => {
    modelSelectionMockFns.resolveModelRefFromString.mockImplementation(
      (params: { raw: string }) => {
        if (params.raw === "anthropic/claude-opus-4-6") {
          return { ref: { provider: "anthropic", model: "claude-opus-4-6" }, alias: false };
        }
        if (params.raw === "openai/gpt-4o") {
          return { ref: { provider: "openai", model: "gpt-4o" }, alias: false };
        }
        return null;
      },
    );

    await getReplyFromConfig(
      buildCtx(),
      {
        modelOverride: "anthropic/claude-opus-4-6",
        modelOverrideFallbacks: ["openai/gpt-4o"],
      },
      buildCfg(["openai/gpt-4o-mini"]),
    );

    // Both primary and fallback are blocked, should use default
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4o-mini",
        hasAppliedImageModelOverride: false,
      }),
    );
  });
});
