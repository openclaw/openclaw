import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../templating.js";
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
const { resolveRunModelFallbacksOverride } = await import("../../agents/agent-scope.js");

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
    vi.mocked(resolveRunModelFallbacksOverride).mockReset();

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
    vi.mocked(resolveRunModelFallbacksOverride).mockReturnValue([
      "openai/gpt-5.2",
      "openai/gpt-5.1",
    ]);

    await getReplyFromConfig(buildCtx(), undefined, {});

    expect(createTypingController).toHaveBeenCalledWith(
      expect.objectContaining({
        typingTtlMs: 555_000,
      }),
    );
  });

  it("keeps a minimum typing TTL for short timeout chains", async () => {
    vi.mocked(resolveAgentTimeoutMs).mockReturnValue(30_000);
    vi.mocked(resolveRunModelFallbacksOverride).mockReturnValue([]);

    await getReplyFromConfig(buildCtx(), undefined, {});

    expect(createTypingController).toHaveBeenCalledWith(
      expect.objectContaining({
        typingTtlMs: 120_000,
      }),
    );
  });

  it("caps typing TTL to avoid unbounded typing loops", async () => {
    vi.mocked(resolveAgentTimeoutMs).mockReturnValue(4_000_000);
    vi.mocked(resolveRunModelFallbacksOverride).mockReturnValue([
      "openai/gpt-5.2",
      "openai/gpt-5.1",
      "openai/gpt-5.0",
    ]);

    await getReplyFromConfig(buildCtx(), undefined, {});

    expect(createTypingController).toHaveBeenCalledWith(
      expect.objectContaining({
        typingTtlMs: 7_200_000,
      }),
    );
  });
});
