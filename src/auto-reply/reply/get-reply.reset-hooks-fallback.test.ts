import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../templating.js";
import { registerGetReplyCommonMocks } from "./get-reply.test-mocks.js";

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  handleInlineActions: vi.fn(),
  emitResetCommandHooks: vi.fn(),
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
  emitResetCommandHooks: (...args: unknown[]) => mocks.emitResetCommandHooks(...args),
}));
vi.mock("./get-reply-directives.js", () => ({
  resolveReplyDirectives: (...args: unknown[]) => mocks.resolveReplyDirectives(...args),
}));
vi.mock("./get-reply-inline-actions.js", () => ({
  handleInlineActions: (...args: unknown[]) => mocks.handleInlineActions(...args),
}));
vi.mock("./session.js", () => ({
  initSessionState: (...args: unknown[]) => mocks.initSessionState(...args),
}));

const { getReplyFromConfig } = await import("./get-reply.js");

function buildNativeResetContext(): MsgContext {
  return {
    Provider: "telegram",
    Surface: "telegram",
    ChatType: "direct",
    Body: "/new",
    RawBody: "/new",
    CommandBody: "/new",
    CommandSource: "native",
    CommandAuthorized: true,
    SessionKey: "telegram:slash:123",
    CommandTargetSessionKey: "agent:main:telegram:direct:123",
    From: "telegram:123",
    To: "slash:123",
  };
}

function buildNativeBtwContext(): MsgContext {
  return {
    Provider: "telegram",
    Surface: "telegram",
    ChatType: "direct",
    Body: "/btw what changed?",
    RawBody: "/btw what changed?",
    CommandBody: "/btw what changed?",
    CommandSource: "native",
    CommandAuthorized: true,
    SessionKey: "telegram:slash:123",
    CommandTargetSessionKey: "agent:main:telegram:direct:123",
    From: "telegram:123",
    To: "slash:123",
  };
}

function createContinueDirectivesResult(resetHookTriggered: boolean) {
  return {
    kind: "continue" as const,
    result: {
      commandSource: "/new",
      command: {
        surface: "telegram",
        channel: "telegram",
        channelId: "telegram",
        ownerList: [],
        senderIsOwner: true,
        isAuthorizedSender: true,
        senderId: "123",
        abortKey: "telegram:slash:123",
        rawBodyNormalized: "/new",
        commandBodyNormalized: "/new",
        from: "telegram:123",
        to: "slash:123",
        resetHookTriggered,
      },
      allowTextCommands: true,
      skillCommands: [],
      directives: {},
      cleanedBody: "/new",
      elevatedEnabled: false,
      elevatedAllowed: false,
      elevatedFailures: [],
      defaultActivation: "always",
      resolvedThinkLevel: undefined,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolvedElevatedLevel: "off",
      execOverrides: undefined,
      blockStreamingEnabled: false,
      blockReplyChunking: undefined,
      resolvedBlockStreamingBreak: undefined,
      provider: "openai",
      model: "gpt-4o-mini",
      modelState: {
        resolveDefaultThinkingLevel: async () => undefined,
      },
      contextTokens: 0,
      inlineStatusRequested: false,
      directiveAck: undefined,
      perMessageQueueMode: undefined,
      perMessageQueueOptions: undefined,
    },
  };
}

describe("getReplyFromConfig reset-hook fallback", () => {
  beforeEach(() => {
    mocks.resolveReplyDirectives.mockReset();
    mocks.handleInlineActions.mockReset();
    mocks.emitResetCommandHooks.mockReset();
    mocks.initSessionState.mockReset();

    mocks.initSessionState.mockResolvedValue({
      sessionCtx: buildNativeResetContext(),
      sessionEntry: {},
      previousSessionEntry: {},
      sessionStore: {},
      sessionKey: "agent:main:telegram:direct:123",
      sessionId: "session-1",
      isNewSession: true,
      resetTriggered: true,
      systemSent: false,
      abortedLastRun: false,
      storePath: "/tmp/sessions.json",
      sessionScope: "per-sender",
      groupResolution: undefined,
      isGroup: false,
      triggerBodyNormalized: "/new",
      bodyStripped: "",
    });

    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult(false));
  });

  it("emits reset hooks when inline actions return early without marking resetHookTriggered", async () => {
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: undefined });

    await getReplyFromConfig(buildNativeResetContext(), undefined, {});

    expect(mocks.emitResetCommandHooks).toHaveBeenCalledTimes(1);
    expect(mocks.emitResetCommandHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "new",
        sessionKey: "agent:main:telegram:direct:123",
      }),
    );
  });

  it("does not emit fallback hooks when resetHookTriggered is already set", async () => {
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: undefined });
    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult(true));

    await getReplyFromConfig(buildNativeResetContext(), undefined, {});

    expect(mocks.emitResetCommandHooks).not.toHaveBeenCalled();
  });

  it("rewrites native /btw to the inline question and resolves the target session read-only", async () => {
    mocks.handleInlineActions.mockResolvedValueOnce({ kind: "reply", reply: undefined });
    mocks.initSessionState.mockResolvedValueOnce({
      sessionCtx: { BodyStripped: "what changed?" },
      sessionEntry: {
        sessionId: "session-1",
        updatedAt: 1,
        sessionFile: "/tmp/session-1.jsonl",
      },
      previousSessionEntry: undefined,
      sessionStore: {},
      sessionKey: "agent:main:telegram:direct:123",
      sessionId: "session-1",
      isNewSession: false,
      resetTriggered: false,
      systemSent: true,
      abortedLastRun: false,
      storePath: "/tmp/sessions.json",
      sessionScope: "per-sender",
      groupResolution: undefined,
      isGroup: false,
      triggerBodyNormalized: "what changed?",
      bodyStripped: "what changed?",
    });
    mocks.resolveReplyDirectives.mockResolvedValueOnce(createContinueDirectivesResult(false));

    await getReplyFromConfig(buildNativeBtwContext(), undefined, {});

    expect(mocks.initSessionState).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          Body: "what changed?",
          CommandBody: "what changed?",
          RawBody: "what changed?",
        }),
        readOnly: true,
      }),
    );
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerBodyNormalized: "what changed?",
        sessionCtx: expect.objectContaining({
          BodyStripped: "what changed?",
        }),
      }),
    );
  });

  it("returns an error for /btw when there is no active target session", async () => {
    mocks.initSessionState.mockResolvedValueOnce({
      sessionCtx: {},
      sessionEntry: {
        sessionId: "session-2",
        updatedAt: 2,
      },
      previousSessionEntry: undefined,
      sessionStore: {},
      sessionKey: "agent:main:telegram:direct:123",
      sessionId: "session-2",
      isNewSession: true,
      resetTriggered: false,
      systemSent: false,
      abortedLastRun: false,
      storePath: "/tmp/sessions.json",
      sessionScope: "per-sender",
      groupResolution: undefined,
      isGroup: false,
      triggerBodyNormalized: "what changed?",
      bodyStripped: "what changed?",
    });

    await expect(getReplyFromConfig(buildNativeBtwContext(), undefined, {})).resolves.toEqual({
      text: "❌ No active session found for /btw.",
    });
  });
});
