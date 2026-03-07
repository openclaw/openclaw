import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchChannelMessageAction: vi.fn(),
  sendMessage: vi.fn(),
  sendPoll: vi.fn(),
  getAgentScopedMediaLocalRoots: vi.fn(() => ["/tmp/agent-roots"]),
  triggerInternalHook: vi.fn().mockResolvedValue(undefined),
  createInternalHookEvent: vi.fn((type, action, sessionKey, context) => ({
    type,
    action,
    sessionKey,
    context,
    timestamp: new Date(),
    messages: [],
  })),
  runMessageSent: vi.fn().mockResolvedValue(undefined),
  hasHooks: vi.fn(),
}));

vi.mock("../../channels/plugins/message-actions.js", () => ({
  dispatchChannelMessageAction: mocks.dispatchChannelMessageAction,
}));

vi.mock("./message.js", () => ({
  sendMessage: mocks.sendMessage,
  sendPoll: mocks.sendPoll,
}));

vi.mock("../../media/local-roots.js", () => ({
  getAgentScopedMediaLocalRoots: mocks.getAgentScopedMediaLocalRoots,
}));

vi.mock("../../hooks/internal-hooks.js", () => ({
  triggerInternalHook: mocks.triggerInternalHook,
  createInternalHookEvent: mocks.createInternalHookEvent,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: mocks.hasHooks,
    runMessageSent: mocks.runMessageSent,
  }),
}));

import { executePollAction, executeSendAction } from "./outbound-send-service.js";

describe("executeSendAction", () => {
  beforeEach(() => {
    mocks.dispatchChannelMessageAction.mockClear();
    mocks.sendMessage.mockClear();
    mocks.sendPoll.mockClear();
    mocks.getAgentScopedMediaLocalRoots.mockClear();
    mocks.triggerInternalHook.mockClear();
    mocks.createInternalHookEvent.mockClear();
    mocks.runMessageSent.mockClear();
    mocks.hasHooks.mockReset();
    mocks.hasHooks.mockReturnValue(false);
  });

  it("forwards ctx.agentId to sendMessage on core outbound path", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(null);
    mocks.sendMessage.mockResolvedValue({
      channel: "discord",
      to: "channel:123",
      via: "direct",
      mediaUrl: null,
    });

    await executeSendAction({
      ctx: {
        cfg: {},
        channel: "discord",
        params: {},
        agentId: "work",
        dryRun: false,
      },
      to: "channel:123",
      message: "hello",
    });

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "work",
        channel: "discord",
        to: "channel:123",
        content: "hello",
      }),
    );
  });

  it("uses plugin poll action when available", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue({
      ok: true,
      value: { messageId: "poll-plugin" },
      continuePrompt: "",
      output: "",
      sessionId: "s1",
      model: "gpt-5.2",
      usage: {},
    });

    const result = await executePollAction({
      ctx: {
        cfg: {},
        channel: "discord",
        params: {},
        dryRun: false,
      },
      to: "channel:123",
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
    });

    expect(result.handledBy).toBe("plugin");
    expect(mocks.sendPoll).not.toHaveBeenCalled();
  });

  it("passes agent-scoped media local roots to plugin dispatch", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue({
      ok: true,
      value: { messageId: "msg-plugin" },
      continuePrompt: "",
      output: "",
      sessionId: "s1",
      model: "gpt-5.2",
      usage: {},
    });

    await executeSendAction({
      ctx: {
        cfg: {},
        channel: "discord",
        params: { to: "channel:123", message: "hello" },
        agentId: "agent-1",
        dryRun: false,
      },
      to: "channel:123",
      message: "hello",
    });

    expect(mocks.getAgentScopedMediaLocalRoots).toHaveBeenCalledWith({}, "agent-1");
    expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaLocalRoots: ["/tmp/agent-roots"],
      }),
    );
  });

  it("emits message_sent and internal message:sent when plugin handles send", async () => {
    mocks.hasHooks.mockImplementation((name: string) => name === "message_sent");
    mocks.dispatchChannelMessageAction.mockResolvedValue({
      ok: true,
      value: { messageId: "msg-plugin" },
      continuePrompt: "",
      output: "",
      sessionId: "s1",
      model: "gpt-5.2",
      usage: {},
    });

    await executeSendAction({
      ctx: {
        cfg: {},
        channel: "telegram",
        params: {},
        dryRun: false,
        accountId: "default",
        mirror: { sessionKey: "agent:main:main", text: "hello" },
      },
      to: "751878683",
      message: "hello",
    });

    expect(mocks.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({ to: "751878683", content: "hello", success: true }),
      expect.objectContaining({ channelId: "telegram", accountId: "default" }),
    );
    expect(mocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "sent",
      "agent:main:main",
      expect.objectContaining({ to: "751878683", channelId: "telegram", success: true }),
    );
    expect(mocks.triggerInternalHook).toHaveBeenCalled();
  });

  it("forwards poll args to sendPoll on core outbound path", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(null);
    mocks.sendPoll.mockResolvedValue({
      channel: "discord",
      to: "channel:123",
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
      durationSeconds: null,
      durationHours: null,
      via: "gateway",
    });

    await executePollAction({
      ctx: {
        cfg: {},
        channel: "discord",
        params: {},
        accountId: "acc-1",
        dryRun: false,
      },
      to: "channel:123",
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
      durationSeconds: 300,
      threadId: "thread-1",
      isAnonymous: true,
    });

    expect(mocks.sendPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        accountId: "acc-1",
        to: "channel:123",
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
        maxSelections: 1,
        durationSeconds: 300,
        threadId: "thread-1",
        isAnonymous: true,
      }),
    );
  });
});
