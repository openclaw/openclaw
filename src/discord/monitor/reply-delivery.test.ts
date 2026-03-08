import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";
import { deliverDiscordReply } from "./reply-delivery.js";
import {
  __testing as threadBindingTesting,
  createThreadBindingManager,
} from "./thread-bindings.js";

const sendMessageDiscordMock = vi.hoisted(() => vi.fn());
const sendVoiceMessageDiscordMock = vi.hoisted(() => vi.fn());
const sendWebhookMessageDiscordMock = vi.hoisted(() => vi.fn());
const sendDiscordTextMock = vi.hoisted(() => vi.fn());

vi.mock("../send.js", () => ({
  sendMessageDiscord: (...args: unknown[]) => sendMessageDiscordMock(...args),
  sendVoiceMessageDiscord: (...args: unknown[]) => sendVoiceMessageDiscordMock(...args),
  sendWebhookMessageDiscord: (...args: unknown[]) => sendWebhookMessageDiscordMock(...args),
}));

vi.mock("../send.shared.js", () => ({
  sendDiscordText: (...args: unknown[]) => sendDiscordTextMock(...args),
}));

vi.mock("../../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils.js")>();
  return { ...actual, sleep: vi.fn().mockResolvedValue(undefined) };
});

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
    sendDiscordTextMock.mockClear().mockResolvedValue({
      id: "msg-direct-1",
      channel_id: "channel-1",
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

  it("passes mediaLocalRoots through media sends", async () => {
    const mediaLocalRoots = ["/tmp/workspace-agent"] as const;
    await deliverDiscordReply({
      replies: [
        {
          text: "Media reply",
          mediaUrls: ["https://example.com/first.png", "https://example.com/second.png"],
        },
      ],
      target: "channel:654",
      token: "token",
      runtime,
      textLimit: 2000,
      mediaLocalRoots,
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(2);
    expect(sendMessageDiscordMock).toHaveBeenNthCalledWith(
      1,
      "channel:654",
      "Media reply",
      expect.objectContaining({
        token: "token",
        mediaUrl: "https://example.com/first.png",
        mediaLocalRoots,
      }),
    );
    expect(sendMessageDiscordMock).toHaveBeenNthCalledWith(
      2,
      "channel:654",
      "",
      expect.objectContaining({
        token: "token",
        mediaUrl: "https://example.com/second.png",
        mediaLocalRoots,
      }),
    );
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

  it("preserves leading whitespace in delivered text chunks", async () => {
    await deliverDiscordReply({
      replies: [{ text: "  leading text" }],
      target: "channel:789",
      token: "token",
      runtime,
      textLimit: 2000,
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:789",
      "  leading text",
      expect.objectContaining({ token: "token" }),
    );
  });

  it("sends text chunks in order via sendDiscordText when rest is provided", async () => {
    const fakeRest = {} as import("@buape/carbon").RequestClient;
    const callOrder: string[] = [];
    sendDiscordTextMock.mockImplementation(
      async (_rest: unknown, _channelId: unknown, text: string) => {
        callOrder.push(text);
        return { id: `msg-${callOrder.length}`, channel_id: "789" };
      },
    );

    await deliverDiscordReply({
      replies: [{ text: "1234567890" }],
      target: "channel:789",
      token: "token",
      rest: fakeRest,
      runtime,
      textLimit: 5,
    });

    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(sendDiscordTextMock).toHaveBeenCalledTimes(2);
    expect(callOrder).toEqual(["12345", "67890"]);
    expect(sendDiscordTextMock.mock.calls[0]?.[1]).toBe("789");
    expect(sendDiscordTextMock.mock.calls[1]?.[1]).toBe("789");
  });

  it("falls back to sendMessageDiscord when rest is not provided", async () => {
    await deliverDiscordReply({
      replies: [{ text: "single chunk" }],
      target: "channel:789",
      token: "token",
      runtime,
      textLimit: 2000,
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendDiscordTextMock).not.toHaveBeenCalled();
  });

  it("retries bot send on 429 rate limit then succeeds", async () => {
    const rateLimitErr = Object.assign(new Error("rate limited"), { status: 429 });
    sendMessageDiscordMock
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce({ messageId: "msg-1", channelId: "channel-1" });

    await deliverDiscordReply({
      replies: [{ text: "retry me" }],
      target: "channel:123",
      token: "token",
      runtime,
      textLimit: 2000,
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(2);
  });

  it("retries bot send on 500 server error then succeeds", async () => {
    const serverErr = Object.assign(new Error("internal"), { status: 500 });
    sendMessageDiscordMock
      .mockRejectedValueOnce(serverErr)
      .mockResolvedValueOnce({ messageId: "msg-1", channelId: "channel-1" });

    await deliverDiscordReply({
      replies: [{ text: "retry me" }],
      target: "channel:123",
      token: "token",
      runtime,
      textLimit: 2000,
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 4xx client errors", async () => {
    const clientErr = Object.assign(new Error("bad request"), { status: 400 });
    sendMessageDiscordMock.mockRejectedValueOnce(clientErr);

    await expect(
      deliverDiscordReply({
        replies: [{ text: "fail" }],
        target: "channel:123",
        token: "token",
        runtime,
        textLimit: 2000,
      }),
    ).rejects.toThrow("bad request");

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting retry attempts", async () => {
    const rateLimitErr = Object.assign(new Error("rate limited"), { status: 429 });
    sendMessageDiscordMock.mockRejectedValue(rateLimitErr);

    await expect(
      deliverDiscordReply({
        replies: [{ text: "persistent failure" }],
        target: "channel:123",
        token: "token",
        runtime,
        textLimit: 2000,
      }),
    ).rejects.toThrow("rate limited");

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(3);
  });

  it("delivers remaining chunks after a mid-sequence retry", async () => {
    sendMessageDiscordMock
      .mockResolvedValueOnce({ messageId: "c1" })
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
      .mockResolvedValueOnce({ messageId: "c2-retry" })
      .mockResolvedValueOnce({ messageId: "c3" });

    await deliverDiscordReply({
      replies: [{ text: "A".repeat(6) }],
      target: "channel:123",
      token: "token",
      runtime,
      textLimit: 2,
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(4);
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

  it("touches bound-thread activity after outbound delivery", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));
      const threadBindings = await createBoundThreadBindings();
      vi.setSystemTime(new Date("2026-02-20T00:02:00.000Z"));

      await deliverDiscordReply({
        replies: [{ text: "Activity ping" }],
        target: "channel:thread-1",
        token: "token",
        runtime,
        textLimit: 2000,
        sessionKey: "agent:main:subagent:child",
        threadBindings,
      });

      expect(threadBindings.getByThreadId("thread-1")?.lastActivityAt).toBe(
        new Date("2026-02-20T00:02:00.000Z").getTime(),
      );
    } finally {
      vi.useRealTimers();
    }
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

// ---------------------------------------------------------------------------
// Retry coverage for webhook, text+media, and voice send paths
// ---------------------------------------------------------------------------

describe("retry coverage for additional send paths", () => {
  const runtime = {} as RuntimeEnv;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sendMessageDiscordMock.mockResolvedValue({ messageId: "m1", channelId: "ch1" });
    sendWebhookMessageDiscordMock.mockResolvedValue({ messageId: "m1", channelId: "ch1" });
    sendVoiceMessageDiscordMock.mockResolvedValue({ messageId: "m1", channelId: "ch1" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries webhook send on 429 embedded in error message", async () => {
    const webhookErr = new Error("Discord webhook send failed (429: rate limited)");
    sendWebhookMessageDiscordMock
      .mockRejectedValueOnce(webhookErr)
      .mockResolvedValueOnce({ messageId: "m1", channelId: "ch1" });

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
    });
    const promise = deliverDiscordReply({
      replies: [{ text: "hello" }],
      target: "channel:thread-1",
      token: "token",
      runtime,
      textLimit: 2000,
      sessionKey: "agent:main:subagent:child",
      threadBindings,
    });
    await vi.advanceTimersByTimeAsync(35_000);
    await promise;

    expect(sendWebhookMessageDiscordMock).toHaveBeenCalledTimes(2);
    // Should NOT fall through to bot sender
    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
  });

  it("retries text+media send on 429", async () => {
    const rateLimitErr = Object.assign(new Error("rate limited"), { status: 429 });
    sendMessageDiscordMock
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce({ messageId: "m1", channelId: "ch1" });

    const promise = deliverDiscordReply({
      replies: [{ text: "hello", mediaUrl: "https://example.com/image.png" }],
      target: "channel:123",
      token: "token",
      runtime,
      textLimit: 2000,
    });
    await vi.advanceTimersByTimeAsync(35_000);
    await promise;

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(2);
  });

  it("retries voice send on 500 server error", async () => {
    const serverErr = Object.assign(new Error("internal"), { status: 500 });
    sendVoiceMessageDiscordMock
      .mockRejectedValueOnce(serverErr)
      .mockResolvedValueOnce({ messageId: "m1", channelId: "ch1" });

    const promise = deliverDiscordReply({
      replies: [{ text: "", mediaUrl: "https://example.com/voice.ogg", audioAsVoice: true }],
      target: "channel:123",
      token: "token",
      runtime,
      textLimit: 2000,
    });
    await vi.advanceTimersByTimeAsync(35_000);
    await promise;

    expect(sendVoiceMessageDiscordMock).toHaveBeenCalledTimes(2);
  });

  it("webhook falls through to bot sender on non-retryable 403", async () => {
    const forbiddenErr = Object.assign(
      new Error("Discord webhook send failed (403: forbidden)"),
      {},
    );
    sendWebhookMessageDiscordMock.mockRejectedValueOnce(forbiddenErr);

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
    });
    const promise = deliverDiscordReply({
      replies: [{ text: "hello" }],
      target: "channel:thread-1",
      token: "token",
      runtime,
      textLimit: 2000,
      sessionKey: "agent:main:subagent:child",
      threadBindings,
    });
    await vi.advanceTimersByTimeAsync(35_000);
    await promise;

    // Webhook failed with 403 (non-retryable) → falls through to bot sender
    expect(sendWebhookMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1);
  });
});
