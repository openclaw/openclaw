import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../templating.js";
import { registerGetReplyCommonMocks } from "./get-reply.test-mocks.js";

const mocks = vi.hoisted(() => {
  const trace = {
    enabled: true,
    kind: "trace" as const,
    update: vi.fn(),
    end: vi.fn(),
    captureError: vi.fn(),
    span: vi.fn(),
    generation: vi.fn(),
  };
  return {
    startLangfuseTrace: vi.fn(async () => trace),
    trace,
    resolveReplyDirectives: vi.fn(),
    initSessionState: vi.fn(),
  };
});

registerGetReplyCommonMocks();

vi.mock("../../observability/langfuse.js", () => ({
  startLangfuseTrace: mocks.startLangfuseTrace,
}));
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
  resolveReplyDirectives: mocks.resolveReplyDirectives,
}));
vi.mock("./get-reply-inline-actions.js", () => ({
  handleInlineActions: vi.fn(async () => ({ kind: "reply", reply: { text: "ok" } })),
}));
vi.mock("./session.js", () => ({
  initSessionState: mocks.initSessionState,
}));

const { getReplyFromConfig } = await import("./get-reply.js");
const { getLangfuseRequestScope } = await import("../../observability/langfuse-request-scope.js");

function buildCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    Provider: "telegram",
    Surface: "telegram",
    ChatType: "private",
    Body: "hello",
    BodyForAgent: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    SessionKey: "agent:main:telegram:direct:42",
    From: "telegram:user:42",
    SenderId: "42",
    MessageSid: "msg-1",
    ...overrides,
  };
}

describe("getReplyFromConfig langfuse trace lifecycle", () => {
  beforeEach(() => {
    mocks.startLangfuseTrace.mockClear();
    mocks.trace.update.mockClear();
    mocks.trace.end.mockClear();
    mocks.trace.captureError.mockClear();
    mocks.resolveReplyDirectives.mockReset();
    mocks.initSessionState.mockReset();

    mocks.resolveReplyDirectives.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
    mocks.initSessionState.mockResolvedValue({
      sessionCtx: {},
      sessionEntry: {},
      previousSessionEntry: {},
      sessionStore: {},
      sessionKey: "agent:main:telegram:direct:42",
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
  });

  it("creates one request trace with inbound metadata and closes it on success", async () => {
    const reply = await getReplyFromConfig(buildCtx(), undefined, {});

    expect(reply).toEqual({ text: "ok" });
    expect(mocks.startLangfuseTrace).toHaveBeenCalledTimes(1);
    expect(mocks.startLangfuseTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "inbound.request",
        sessionId: "agent:main:telegram:direct:42",
        userId: "42",
        input: { body: "hello" },
        metadata: expect.objectContaining({
          sessionKey: "agent:main:telegram:direct:42",
          messageId: "msg-1",
          senderId: "42",
          surface: "telegram",
          chatType: "private",
        }),
      }),
    );
    expect(mocks.trace.end).toHaveBeenCalledWith(
      expect.objectContaining({
        output: { text: "ok" },
        metadata: expect.objectContaining({ replyKind: "single" }),
      }),
    );
  });

  it("redacts and truncates inbound trace payloads", async () => {
    mocks.resolveReplyDirectives.mockResolvedValue({
      kind: "reply",
      reply: {
        text: "safe",
        metadata: {
          token: "reply-secret",
          note: "y".repeat(2_100),
        },
      },
    });

    await getReplyFromConfig(
      buildCtx({
        BodyForAgent: "x".repeat(4_500),
        Body: "x".repeat(4_500),
      }),
      undefined,
      {},
    );

    expect(mocks.startLangfuseTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          body: expect.stringContaining("…[truncated]"),
        },
      }),
    );
    expect(mocks.trace.end).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({
          text: "safe",
          metadata: expect.objectContaining({
            token: "[REDACTED]",
            note: expect.stringContaining("…[truncated]"),
          }),
        }),
      }),
    );
  });

  it("keeps trace context available inside request scope and captures failures", async () => {
    mocks.resolveReplyDirectives.mockImplementation(async () => {
      expect(getLangfuseRequestScope()?.trace).toBe(mocks.trace);
      throw new Error("boom");
    });

    await expect(
      getReplyFromConfig(buildCtx({ MessageSid: "msg-fail" }), undefined, {}),
    ).rejects.toThrow("boom");

    expect(mocks.startLangfuseTrace).toHaveBeenCalledTimes(1);
    expect(mocks.trace.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        metadata: expect.objectContaining({ messageId: "msg-fail" }),
      }),
    );
    expect(mocks.trace.end).not.toHaveBeenCalled();
  });
});
