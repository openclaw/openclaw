import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";
import { deliverDiscordReply } from "./reply-delivery.js";
import {
  __testing as threadBindingTesting,
  createThreadBindingManager,
} from "./thread-bindings.js";

const sendMessageDiscordMock = vi.hoisted(() => vi.fn());
const sendVoiceMessageDiscordMock = vi.hoisted(() => vi.fn());
const sendWebhookMessageDiscordMock = vi.hoisted(() => vi.fn());

vi.mock("../send.js", () => ({
  sendMessageDiscord: (...args: unknown[]) => sendMessageDiscordMock(...args),
  sendVoiceMessageDiscord: (...args: unknown[]) => sendVoiceMessageDiscordMock(...args),
  sendWebhookMessageDiscord: (...args: unknown[]) => sendWebhookMessageDiscordMock(...args),
}));

describe("deliverDiscordReply", () => {
  const runtime = {} as RuntimeEnv;
  const createBoundThreadBindings = async (
    overrides: Partial<{
      threadId: string;
      channelId: string;
      targetSessionKey: string;
      agentId: string;
      label: string;
      webhookId: string;
      webhookToken: string;
      introText: string;
    }> = {},
  ) => {
    const threadBindings = createThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });
    await threadBindings.bindTarget({
      threadId: "thread-1",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
      agentId: "main",
      webhookId: "wh_1",
      webhookToken: "tok_1",
      introText: "",
      ...overrides,
    });
    return threadBindings;
  };

  beforeEach(() => {
    sendMessageDiscordMock.mockClear().mockResolvedValue({
      messageId: "msg-1",
      channelId: "channel-1",
    });
    sendVoiceMessageDiscordMock.mockClear().mockResolvedValue({
      messageId: "voice-1",
      channelId: "channel-1",
    });
    sendWebhookMessageDiscordMock.mockClear().mockResolvedValue({
      messageId: "webhook-1",
      channelId: "thread-1",
    });
    threadBindingTesting.resetThreadBindingsForTests();
  });

  it("routes audioAsVoice payloads through the voice API and sends text separately", async () => {
    await deliverDiscordReply({
      replies: [
        {
          text: "Hello there",
          mediaUrls: ["https://example.com/voice.ogg", "https://example.com/extra.mp3"],
          audioAsVoice: true,
        },
      ],
      target: "channel:123",
      token: "token",
      runtime,
      textLimit: 2000,
      replyToId: "reply-1",
    });

    expect(sendVoiceMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendVoiceMessageDiscordMock).toHaveBeenCalledWith(
      "channel:123",
      "https://example.com/voice.ogg",
      expect.objectContaining({ token: "token", replyTo: "reply-1" }),
    );

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(2);
    expect(sendMessageDiscordMock).toHaveBeenNthCalledWith(
      1,
      "channel:123",
      "Hello there",
      expect.objectContaining({ token: "token", replyTo: "reply-1" }),
    );
    expect(sendMessageDiscordMock).toHaveBeenNthCalledWith(
      2,
      "channel:123",
      "",
      expect.objectContaining({
        token: "token",
        mediaUrl: "https://example.com/extra.mp3",
        replyTo: "reply-1",
      }),
    );
  });

  it("skips follow-up text when the voice payload text is blank", async () => {
    await deliverDiscordReply({
      replies: [
        {
          text: "   ",
          mediaUrl: "https://example.com/voice.ogg",
          audioAsVoice: true,
        },
      ],
      target: "channel:456",
      token: "token",
      runtime,
      textLimit: 2000,
    });

    expect(sendVoiceMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
  });

  it("uses replyToId only for the first chunk when replyToMode is first", async () => {
    await deliverDiscordReply({
      replies: [
        {
          text: "1234567890",
        },
      ],
      target: "channel:789",
      token: "token",
      runtime,
      textLimit: 5,
      replyToId: "reply-1",
      replyToMode: "first",
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(2);
    expect(sendMessageDiscordMock.mock.calls[0]?.[2]?.replyTo).toBe("reply-1");
    expect(sendMessageDiscordMock.mock.calls[1]?.[2]?.replyTo).toBeUndefined();
  });

  it("does not consume replyToId for replyToMode=first on whitespace-only payloads", async () => {
    await deliverDiscordReply({
      replies: [{ text: "   " }, { text: "actual reply" }],
      target: "channel:789",
      token: "token",
      runtime,
      textLimit: 2000,
      replyToId: "reply-1",
      replyToMode: "first",
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:789",
      "actual reply",
      expect.objectContaining({ token: "token", replyTo: "reply-1" }),
    );
  });

  it("sends bound-session text replies through webhook delivery", async () => {
    const threadBindings = await createBoundThreadBindings({ label: "codex-refactor" });

    await deliverDiscordReply({
      replies: [{ text: "Hello from subagent" }],
      target: "channel:thread-1",
      token: "token",
      runtime,
      textLimit: 2000,
      replyToId: "reply-1",
      sessionKey: "agent:main:subagent:child",
      threadBindings,
    });

    expect(sendWebhookMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendWebhookMessageDiscordMock).toHaveBeenCalledWith(
      "Hello from subagent",
      expect.objectContaining({
        webhookId: "wh_1",
        webhookToken: "tok_1",
        accountId: "default",
        threadId: "thread-1",
        replyTo: "reply-1",
      }),
    );
    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
  });

  it("falls back to bot send when webhook delivery fails", async () => {
    const threadBindings = await createBoundThreadBindings();
    sendWebhookMessageDiscordMock.mockRejectedValueOnce(new Error("rate limited"));

    await deliverDiscordReply({
      replies: [{ text: "Fallback path" }],
      target: "channel:thread-1",
      token: "token",
      accountId: "default",
      runtime,
      textLimit: 2000,
      sessionKey: "agent:main:subagent:child",
      threadBindings,
    });

    expect(sendWebhookMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:thread-1",
      "Fallback path",
      expect.objectContaining({ token: "token", accountId: "default" }),
    );
  });

  it("does not use thread webhook when outbound target is not a bound thread", async () => {
    const threadBindings = await createBoundThreadBindings();

    await deliverDiscordReply({
      replies: [{ text: "Parent channel delivery" }],
      target: "channel:parent-1",
      token: "token",
      accountId: "default",
      runtime,
      textLimit: 2000,
      sessionKey: "agent:main:subagent:child",
      threadBindings,
    });

    expect(sendWebhookMessageDiscordMock).not.toHaveBeenCalled();
    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:parent-1",
      "Parent channel delivery",
      expect.objectContaining({ token: "token", accountId: "default" }),
    );
  });
});
