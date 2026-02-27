import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";

vi.mock("../../../slack/send.js", () => ({
  sendMessageSlack: vi.fn().mockResolvedValue({ messageId: "1234.5678", channelId: "C123" }),
}));

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(),
}));

import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { sendMessageSlack } from "../../../slack/send.js";
import { slackOutbound } from "./slack.js";

type SlackSendTextCtx = {
  to: string;
  text: string;
  accountId: string;
  replyToId: string;
  identity?: {
    name?: string;
    avatarUrl?: string;
    emoji?: string;
  };
};

const BASE_SLACK_SEND_CTX = {
  to: "C123",
  accountId: "default",
  replyToId: "1111.2222",
} as const;

const sendSlackText = async (ctx: SlackSendTextCtx) => {
  const sendText = slackOutbound.sendText as NonNullable<typeof slackOutbound.sendText>;
  return await sendText({
    cfg: {} as OpenClawConfig,
    ...ctx,
  });
};

const sendSlackTextWithDefaults = async (
  overrides: Partial<SlackSendTextCtx> & Pick<SlackSendTextCtx, "text">,
) => {
  return await sendSlackText({
    ...BASE_SLACK_SEND_CTX,
    ...overrides,
  });
};

const expectSlackSendCalledWith = (
  text: string,
  options?: {
    identity?: {
      username?: string;
      iconUrl?: string;
      iconEmoji?: string;
    };
  },
) => {
  expect(sendMessageSlack).toHaveBeenCalledWith("C123", text, {
    threadTs: "1111.2222",
    accountId: "default",
    ...options,
  });
};

describe("slack outbound hook wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls send without hooks when no hooks registered", async () => {
    vi.mocked(getGlobalHookRunner).mockReturnValue(null);

    await sendSlackTextWithDefaults({ text: "hello" });
    expectSlackSendCalledWith("hello");
  });

  it("forwards identity opts when present", async () => {
    vi.mocked(getGlobalHookRunner).mockReturnValue(null);

    await sendSlackTextWithDefaults({
      text: "hello",
      identity: {
        name: "My Agent",
        avatarUrl: "https://example.com/avatar.png",
        emoji: ":should_not_send:",
      },
    });

    expectSlackSendCalledWith("hello", {
      identity: { username: "My Agent", iconUrl: "https://example.com/avatar.png" },
    });
  });

  it("forwards icon_emoji only when icon_url is absent", async () => {
    vi.mocked(getGlobalHookRunner).mockReturnValue(null);

    await sendSlackTextWithDefaults({
      text: "hello",
      identity: { emoji: ":lobster:" },
    });

    expectSlackSendCalledWith("hello", {
      identity: { iconEmoji: ":lobster:" },
    });
  });

  it("calls message_sending hook before sending", async () => {
    const mockRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runMessageSending: vi.fn().mockResolvedValue(undefined),
    };
    // oxlint-disable-next-line typescript/no-explicit-any
    vi.mocked(getGlobalHookRunner).mockReturnValue(mockRunner as any);

    await sendSlackTextWithDefaults({ text: "hello" });

    expect(mockRunner.hasHooks).toHaveBeenCalledWith("message_sending");
    expect(mockRunner.runMessageSending).toHaveBeenCalledWith(
      { to: "C123", content: "hello", metadata: { threadTs: "1111.2222", channelId: "C123" } },
      { channelId: "slack", accountId: "default" },
    );
    expectSlackSendCalledWith("hello");
  });

  it("cancels send when hook returns cancel:true", async () => {
    const mockRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runMessageSending: vi.fn().mockResolvedValue({ cancel: true }),
    };
    // oxlint-disable-next-line typescript/no-explicit-any
    vi.mocked(getGlobalHookRunner).mockReturnValue(mockRunner as any);

    const result = await sendSlackTextWithDefaults({ text: "hello" });

    expect(sendMessageSlack).not.toHaveBeenCalled();
    expect(result.channel).toBe("slack");
  });

  it("modifies text when hook returns content", async () => {
    const mockRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runMessageSending: vi.fn().mockResolvedValue({ content: "modified" }),
    };
    // oxlint-disable-next-line typescript/no-explicit-any
    vi.mocked(getGlobalHookRunner).mockReturnValue(mockRunner as any);

    await sendSlackTextWithDefaults({ text: "original" });
    expectSlackSendCalledWith("modified");
  });

  it("skips hooks when runner has no message_sending hooks", async () => {
    const mockRunner = {
      hasHooks: vi.fn().mockReturnValue(false),
      runMessageSending: vi.fn(),
    };
    // oxlint-disable-next-line typescript/no-explicit-any
    vi.mocked(getGlobalHookRunner).mockReturnValue(mockRunner as any);

    await sendSlackTextWithDefaults({ text: "hello" });

    expect(mockRunner.runMessageSending).not.toHaveBeenCalled();
    expect(sendMessageSlack).toHaveBeenCalled();
  });
});
