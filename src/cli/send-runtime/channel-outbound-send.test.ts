import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelOutboundRuntimeSend } from "./channel-outbound-send.js";

const mocks = vi.hoisted(() => ({
  loadChannelOutboundAdapter: vi.fn(),
  loadConfig: vi.fn(() => ({ test: true })),
}));

vi.mock("../../channels/plugins/outbound/load.js", () => ({
  loadChannelOutboundAdapter: mocks.loadChannelOutboundAdapter,
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

describe("createChannelOutboundRuntimeSend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes media sends through sendMedia and preserves media access", async () => {
    const sendText = vi.fn();
    const sendMedia = vi.fn(async () => ({ channel: "whatsapp", messageId: "wa-1" }));
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendText,
      sendMedia,
    });

    const mediaReadFile = vi.fn(async () => Buffer.from("image"));
    const runtimeSend = createChannelOutboundRuntimeSend({
      channelId: "whatsapp" as never,
      unavailableMessage: "unavailable",
    });

    await runtimeSend.sendMessage("+15551234567", "caption", {
      cfg: {},
      mediaUrl: "file:///tmp/photo.png",
      mediaAccess: {
        localRoots: ["/tmp/workspace"],
        readFile: mediaReadFile,
      },
      mediaLocalRoots: ["/tmp/fallback-root"],
      mediaReadFile,
      accountId: "default",
      threadId: "$thread-root",
      replyToId: "$parent",
      gifPlayback: true,
      gatewayClientScopes: ["messages:send"],
    });

    expect(sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {},
        to: "+15551234567",
        text: "caption",
        mediaUrl: "file:///tmp/photo.png",
        mediaAccess: {
          localRoots: ["/tmp/workspace"],
          readFile: mediaReadFile,
        },
        mediaLocalRoots: ["/tmp/fallback-root"],
        mediaReadFile,
        accountId: "default",
        threadId: "$thread-root",
        replyToId: "$parent",
        gifPlayback: true,
        gatewayClientScopes: ["messages:send"],
      }),
    );
    expect(sendText).not.toHaveBeenCalled();
  });

  it("uses message thread aliases for plugin outbound sends", async () => {
    const sendMedia = vi.fn(async () => ({ messageId: "wa-1" }));
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendMedia,
    });

    const runtimeSend = createChannelOutboundRuntimeSend({
      channelId: "whatsapp" as never,
      unavailableMessage: "missing outbound",
    });

    await runtimeSend.sendMessage("120363426179087288@g.us", "caption", {
      mediaUrl: "/tmp/agreement.pdf",
      mediaLocalRoots: ["/tmp"],
      accountId: "default",
      messageThreadId: "thread-1",
      replyToMessageId: "42",
      silent: true,
      forceDocument: true,
      gifPlayback: true,
    });

    expect(sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: { test: true },
        to: "120363426179087288@g.us",
        text: "caption",
        mediaUrl: "/tmp/agreement.pdf",
        mediaLocalRoots: ["/tmp"],
        accountId: "default",
        threadId: "thread-1",
        replyToId: "42",
        silent: true,
        forceDocument: true,
        gifPlayback: true,
      }),
    );
  });

  it("falls back to sendText for text-only sends", async () => {
    const sendText = vi.fn(async () => ({ channel: "whatsapp", messageId: "wa-2" }));
    const sendMedia = vi.fn();
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendText,
      sendMedia,
    });

    const runtimeSend = createChannelOutboundRuntimeSend({
      channelId: "whatsapp" as never,
      unavailableMessage: "unavailable",
    });

    await runtimeSend.sendMessage("+15551234567", "hello", {
      cfg: {},
      accountId: "default",
    });

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {},
        to: "+15551234567",
        text: "hello",
        accountId: "default",
      }),
    );
    expect(sendMedia).not.toHaveBeenCalled();
  });

  it("accepts plugin outbound thread and reply aliases", async () => {
    const sendText = vi.fn(async () => ({ channel: "matrix", messageId: "$reply" }));
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendText,
    });

    const runtimeSend = createChannelOutboundRuntimeSend({
      channelId: "matrix" as never,
      unavailableMessage: "unavailable",
    });

    await runtimeSend.sendMessage("room:!ops:example.org", "hello thread", {
      cfg: {},
      accountId: "sut",
      replyToId: "$parent",
      threadId: "$thread-root",
    });

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "sut",
        replyToId: "$parent",
        threadId: "$thread-root",
        to: "room:!ops:example.org",
      }),
    );
  });

  it("forwards Slack threadTs alias to threadId", async () => {
    const sendText = vi.fn(async () => ({ channel: "slack", messageId: "slack-1" }));
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendText,
    });

    const { createChannelOutboundRuntimeSend } = await import("./channel-outbound-send.js");
    const runtimeSend = createChannelOutboundRuntimeSend({
      channelId: "slack" as never,
      unavailableMessage: "unavailable",
    });

    await runtimeSend.sendMessage("C123", "hello", {
      cfg: {},
      threadTs: "1712345678.123456",
    });

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {},
        to: "C123",
        text: "hello",
        threadId: "1712345678.123456",
      }),
    );
  });

  it("prefers canonical thread fields over Slack aliases", async () => {
    const sendText = vi.fn(async () => ({ channel: "slack", messageId: "slack-2" }));
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendText,
    });

    const { createChannelOutboundRuntimeSend } = await import("./channel-outbound-send.js");
    const runtimeSend = createChannelOutboundRuntimeSend({
      channelId: "slack" as never,
      unavailableMessage: "unavailable",
    });

    await runtimeSend.sendMessage("C123", "hello", {
      cfg: {},
      messageThreadId: "200.000",
      threadId: "150.000",
      threadTs: "100.000",
      replyToMessageId: "400.000",
      replyToId: "300.000",
    });

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {},
        threadId: "200.000",
        replyToId: "400.000",
      }),
    );
  });

  it("falls back to sendText when media is present but sendMedia is unavailable", async () => {
    const sendText = vi.fn(async () => ({ channel: "whatsapp", messageId: "wa-3" }));
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendText,
    });

    const mediaReadFile = vi.fn(async () => Buffer.from("pdf"));
    const runtimeSend = createChannelOutboundRuntimeSend({
      channelId: "whatsapp" as never,
      unavailableMessage: "unavailable",
    });

    await runtimeSend.sendMessage("+15551234567", "caption", {
      cfg: {},
      mediaUrl: "file:///tmp/test.pdf",
      mediaAccess: {
        localRoots: ["/tmp/workspace"],
        readFile: mediaReadFile,
      },
      mediaLocalRoots: ["/tmp/fallback-root"],
      mediaReadFile,
      accountId: "default",
      forceDocument: true,
    });

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {},
        to: "+15551234567",
        text: "caption",
        mediaUrl: "file:///tmp/test.pdf",
        mediaAccess: {
          localRoots: ["/tmp/workspace"],
          readFile: mediaReadFile,
        },
        mediaLocalRoots: ["/tmp/fallback-root"],
        mediaReadFile,
        accountId: "default",
        forceDocument: true,
      }),
    );
  });
});
