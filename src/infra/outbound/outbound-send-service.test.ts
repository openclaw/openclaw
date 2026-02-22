import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchChannelMessageAction: vi.fn(),
  sendMessage: vi.fn(),
  sendPoll: vi.fn(),
}));

vi.mock("../../channels/plugins/message-actions.js", () => ({
  dispatchChannelMessageAction: (...args: unknown[]) => mocks.dispatchChannelMessageAction(...args),
}));

vi.mock("./message.js", () => ({
  sendMessage: (...args: unknown[]) => mocks.sendMessage(...args),
  sendPoll: (...args: unknown[]) => mocks.sendPoll(...args),
}));

import { executePollAction, executeSendAction } from "./outbound-send-service.js";

describe("executeSendAction", () => {
  beforeEach(() => {
    mocks.dispatchChannelMessageAction.mockClear();
    mocks.sendMessage.mockClear();
    mocks.sendPoll.mockClear();
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
