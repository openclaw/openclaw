import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

const handleCommandsMock = vi.fn();

vi.mock("./commands.js", () => ({
  handleCommands: (...args: unknown[]) => handleCommandsMock(...args),
  buildStatusReply: vi.fn(),
  buildCommandContext: vi.fn(),
}));

// Import after mocks.
const { handleInlineActions } = await import("./get-reply-inline-actions.js");
type HandleInlineActionsInput = Parameters<typeof handleInlineActions>[0];

const createTypingController = (): TypingController => ({
  onReplyStart: async () => {},
  startTypingLoop: async () => {},
  startTypingOnText: async () => {},
  refreshTypingTtl: () => {},
  isActive: () => false,
  markRunComplete: () => {},
  markDispatchIdle: () => {},
  cleanup: vi.fn(),
});

const createHandleInlineActionsInput = (params: {
  ctx: ReturnType<typeof buildTestCtx>;
  typing: TypingController;
  cleanedBody: string;
  command?: Partial<HandleInlineActionsInput["command"]>;
  overrides?: Partial<Omit<HandleInlineActionsInput, "ctx" | "sessionCtx" | "typing" | "command">>;
}): HandleInlineActionsInput => {
  const baseCommand: HandleInlineActionsInput["command"] = {
    surface: "whatsapp",
    channel: "whatsapp",
    channelId: "whatsapp",
    ownerList: [],
    senderIsOwner: false,
    isAuthorizedSender: false,
    senderId: undefined,
    abortKey: "whatsapp:+999",
    rawBodyNormalized: params.cleanedBody,
    commandBodyNormalized: params.cleanedBody,
    from: "whatsapp:+999",
    to: "whatsapp:+999",
  };
  return {
    ctx: params.ctx,
    sessionCtx: params.ctx as unknown as TemplateContext,
    cfg: {},
    agentId: "main",
    sessionKey: "s:main",
    workspaceDir: "/tmp",
    isGroup: false,
    typing: params.typing,
    allowTextCommands: false,
    inlineStatusRequested: false,
    command: {
      ...baseCommand,
      ...params.command,
    },
    directives: clearInlineDirectives(params.cleanedBody),
    cleanedBody: params.cleanedBody,
    elevatedEnabled: false,
    elevatedAllowed: false,
    elevatedFailures: [],
    defaultActivation: () => "always",
    resolvedThinkLevel: undefined,
    resolvedVerboseLevel: undefined,
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    resolveDefaultThinkingLevel: async () => "off",
    provider: "openai",
    model: "gpt-4o-mini",
    contextTokens: 0,
    abortedLastRun: false,
    sessionScope: "per-sender",
    ...params.overrides,
  };
};

describe("handleInlineActions", () => {
  beforeEach(() => {
    handleCommandsMock.mockReset();
  });

  it("skips whatsapp replies when config is empty and From !== To", async () => {
    const typing = createTypingController();

    const ctx = buildTestCtx({
      From: "whatsapp:+999",
      To: "whatsapp:+123",
      Body: "hi",
    });
    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        ctx,
        typing,
        cleanedBody: "hi",
        command: { to: "whatsapp:+123" },
      }),
    );

    expect(result).toEqual({ kind: "reply", reply: undefined });
    expect(typing.cleanup).toHaveBeenCalled();
    expect(handleCommandsMock).not.toHaveBeenCalled();
  });

  it("forwards agentDir into handleCommands", async () => {
    const typing = createTypingController();

    handleCommandsMock.mockResolvedValue({ shouldContinue: false, reply: { text: "done" } });

    const ctx = buildTestCtx({
      Body: "/status",
      CommandBody: "/status",
    });
    const agentDir = "/tmp/inline-agent";

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        ctx,
        typing,
        cleanedBody: "/status",
        command: {
          isAuthorizedSender: true,
          senderId: "sender-1",
          abortKey: "sender-1",
        },
        overrides: {
          cfg: { commands: { text: true } },
          agentDir,
        },
      }),
    );

    expect(result).toEqual({ kind: "reply", reply: { text: "done" } });
    expect(handleCommandsMock).toHaveBeenCalledTimes(1);
    expect(handleCommandsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir,
      }),
    );
  });

  it("skips stale queued messages that are at or before the /stop cutoff", async () => {
    const typing = createTypingController();
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      abortCutoffMessageSid: "42",
      abortedLastRun: true,
    };
    const sessionStore = { "s:main": sessionEntry };
    const ctx = buildTestCtx({
      Body: "old queued message",
      CommandBody: "old queued message",
      MessageSid: "41",
    });

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        ctx,
        typing,
        cleanedBody: "old queued message",
        command: {
          rawBodyNormalized: "old queued message",
          commandBodyNormalized: "old queued message",
        },
        overrides: {
          sessionEntry,
          sessionStore,
        },
      }),
    );

    expect(result).toEqual({ kind: "reply", reply: undefined });
    expect(typing.cleanup).toHaveBeenCalled();
    expect(handleCommandsMock).not.toHaveBeenCalled();
  });

  it("clears /stop cutoff when a newer message arrives", async () => {
    const typing = createTypingController();
    const sessionEntry: SessionEntry = {
      sessionId: "session-2",
      updatedAt: Date.now(),
      abortCutoffMessageSid: "42",
      abortedLastRun: true,
    };
    const sessionStore = { "s:main": sessionEntry };
    handleCommandsMock.mockResolvedValue({ shouldContinue: false, reply: { text: "ok" } });
    const ctx = buildTestCtx({
      Body: "new message",
      CommandBody: "new message",
      MessageSid: "43",
    });

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        ctx,
        typing,
        cleanedBody: "new message",
        command: {
          rawBodyNormalized: "new message",
          commandBodyNormalized: "new message",
        },
        overrides: {
          sessionEntry,
          sessionStore,
        },
      }),
    );

    expect(result).toEqual({ kind: "reply", reply: { text: "ok" } });
    expect(sessionStore["s:main"]?.abortCutoffMessageSid).toBeUndefined();
    expect(sessionStore["s:main"]?.abortCutoffTimestamp).toBeUndefined();
    expect(handleCommandsMock).toHaveBeenCalledTimes(1);
  });
});
