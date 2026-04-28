import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../templating.js";
import { withFastReplyConfig, withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { registerGetReplyCommonMocks } from "./get-reply.test-mocks.js";

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  initSessionState: vi.fn(),
}));

registerGetReplyCommonMocks();

vi.mock("../../link-understanding/apply.js", () => ({
  applyLinkUnderstanding: vi.fn(async () => undefined),
}));
vi.mock("../../media-understanding/apply.js", () => ({
  applyMediaUnderstanding: vi.fn(async () => undefined),
}));
vi.mock("./commands-core.js", () => ({
  emitResetCommandHooks: vi.fn(async () => undefined),
}));
vi.mock("./get-reply-directives.js", () => ({
  resolveReplyDirectives: (...args: unknown[]) => mocks.resolveReplyDirectives(...args),
}));
vi.mock("./session.js", () => ({
  initSessionState: (...args: unknown[]) => mocks.initSessionState(...args),
}));

const { getReplyFromConfig } = await import("./get-reply.js");
const { createTypingController } = await import("./typing.js");
const { resolveAgentTimeoutMs } = await import("../../agents/timeout.js");
const { resolveEffectiveModelFallbacks } = await import("../../agents/agent-scope.js");
const { resolveModelRefFromString } = await import("../../agents/model-selection.js");

function buildCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: "telegram:-100123",
    ChatType: "group",
    Body: "hello",
    BodyForAgent: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    SessionKey: "agent:main:telegram:-100123",
    From: "telegram:user:42",
    To: "telegram:-100123",
    GroupChannel: "ops",
    Timestamp: 1710000000000,
    ...overrides,
  };
}

describe("getReply typing timeout budget", () => {
  beforeEach(() => {
    mocks.resolveReplyDirectives.mockReset();
    mocks.initSessionState.mockReset();
    vi.mocked(createTypingController).mockClear();
    vi.mocked(resolveAgentTimeoutMs).mockReset();
    vi.mocked(resolveEffectiveModelFallbacks).mockReset();
    vi.mocked(resolveModelRefFromString).mockImplementation(({ raw, defaultProvider }) => {
      const trimmed = raw.trim();
      const slashIndex = trimmed.indexOf("/");
      const ref =
        slashIndex === -1
          ? { provider: defaultProvider, model: trimmed }
          : {
              provider: trimmed.slice(0, slashIndex),
              model: trimmed.slice(slashIndex + 1),
            };
      return { ref };
    });

    mocks.resolveReplyDirectives.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
    mocks.initSessionState.mockResolvedValue({
      sessionCtx: {},
      sessionEntry: {},
      previousSessionEntry: {},
      sessionStore: {},
      sessionKey: "agent:main:telegram:-100123",
      sessionId: "session-1",
      isNewSession: false,
      resetTriggered: false,
      systemSent: false,
      abortedLastRun: false,
      storePath: "/tmp/sessions.json",
      sessionScope: "per-chat",
      groupResolution: undefined,
      isGroup: true,
      triggerBodyNormalized: "",
      bodyStripped: "",
    });
  });

  it("extends typing TTL based on timeout and fallback chain budget", async () => {
    vi.mocked(resolveAgentTimeoutMs).mockReturnValue(90_000);
    vi.mocked(resolveEffectiveModelFallbacks).mockReturnValue(["openai/gpt-5.2", "openai/gpt-5.1"]);

    await getReplyFromConfig(buildCtx(), undefined, withFastReplyConfig({}));

    expect(createTypingController).toHaveBeenCalledWith(
      expect.objectContaining({
        typingTtlMs: 555_000,
      }),
    );
  });

  it("keeps a minimum typing TTL for short timeout chains", async () => {
    vi.mocked(resolveAgentTimeoutMs).mockReturnValue(30_000);
    vi.mocked(resolveEffectiveModelFallbacks).mockReturnValue([]);

    await getReplyFromConfig(buildCtx(), undefined, withFastReplyConfig({}));

    expect(createTypingController).toHaveBeenCalledWith(
      expect.objectContaining({
        typingTtlMs: 120_000,
      }),
    );
  });

  it("caps typing TTL to avoid unbounded typing loops", async () => {
    vi.mocked(resolveAgentTimeoutMs).mockReturnValue(4_000_000);
    vi.mocked(resolveEffectiveModelFallbacks).mockReturnValue([
      "openai/gpt-5.2",
      "openai/gpt-5.1",
      "openai/gpt-5.0",
    ]);

    await getReplyFromConfig(buildCtx(), undefined, withFastReplyConfig({}));

    expect(createTypingController).toHaveBeenCalledWith(
      expect.objectContaining({
        typingTtlMs: 7_200_000,
      }),
    );
  });

  it("includes the configured primary appended to an override run", async () => {
    vi.mocked(resolveAgentTimeoutMs).mockReturnValue(60_000);

    await getReplyFromConfig(
      buildCtx(),
      { isHeartbeat: true, heartbeatModelOverride: "google/gemini-2.5-pro" },
      withFastReplyConfig({
        agents: {
          defaults: {
            heartbeat: { model: "google/gemini-2.5-pro" },
            model: { primary: "anthropic/claude-sonnet-4.6" },
          },
        },
      }),
    );

    expect(createTypingController).toHaveBeenCalledWith(
      expect.objectContaining({
        typingTtlMs: 255_000,
      }),
    );
  });

  it("uses the user-selected session override budget without default fallbacks", async () => {
    vi.mocked(resolveAgentTimeoutMs).mockReturnValue(60_000);
    vi.mocked(resolveEffectiveModelFallbacks).mockReturnValue([]);
    mocks.initSessionState.mockResolvedValueOnce({
      sessionCtx: {},
      sessionEntry: {
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4.6",
        modelOverrideSource: "user",
      },
      previousSessionEntry: {},
      sessionStore: {},
      sessionKey: "agent:main:telegram:-100123",
      sessionId: "session-1",
      isNewSession: false,
      resetTriggered: false,
      systemSent: false,
      abortedLastRun: false,
      storePath: "/tmp/sessions.json",
      sessionScope: "per-chat",
      groupResolution: undefined,
      isGroup: true,
      triggerBodyNormalized: "",
      bodyStripped: "",
    });

    await getReplyFromConfig(
      buildCtx(),
      undefined,
      withFullRuntimeReplyConfig({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4",
              fallbacks: ["openai/gpt-5.2", "openai/gpt-5.1"],
            },
          },
        },
      }),
    );

    expect(resolveEffectiveModelFallbacks).toHaveBeenCalledWith(
      expect.objectContaining({
        hasSessionModelOverride: true,
        modelOverrideSource: "user",
      }),
    );
    expect(createTypingController).toHaveBeenCalledWith(
      expect.objectContaining({
        typingTtlMs: 135_000,
      }),
    );
  });
});
