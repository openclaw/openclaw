import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";

const sendMessageIMessageMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ messageId: "imsg-1" }),
);
const chunkTextWithModeMock = vi.hoisted(() => vi.fn((text: string) => [text]));
const resolveChunkModeMock = vi.hoisted(() => vi.fn(() => "length"));
const convertMarkdownTablesMock = vi.hoisted(() => vi.fn((text: string) => text));
const resolveMarkdownTableModeMock = vi.hoisted(() => vi.fn(() => "code"));
const emitHookMock = vi.hoisted(() => vi.fn());

vi.mock("../send.js", () => ({
  sendMessageIMessage: (to: string, message: string, opts?: unknown) =>
    sendMessageIMessageMock(to, message, opts),
}));

vi.mock("../../auto-reply/chunk.js", () => ({
  chunkTextWithMode: (text: string) => chunkTextWithModeMock(text),
  resolveChunkMode: () => resolveChunkModeMock(),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("../../config/markdown-tables.js", () => ({
  resolveMarkdownTableMode: () => resolveMarkdownTableModeMock(),
}));

vi.mock("../../markdown/tables.js", () => ({
  convertMarkdownTables: (text: string) => convertMarkdownTablesMock(text),
}));

vi.mock("../../hooks/emit-message-sent.js", () => ({
  emitMessageSentHook: (...args: unknown[]) => emitHookMock(...args),
}));

import { deliverReplies } from "./deliver.js";

describe("deliverReplies", () => {
  const runtime = { log: vi.fn(), error: vi.fn() } as unknown as RuntimeEnv;
  const client = {} as Awaited<ReturnType<typeof import("../client.js").createIMessageRpcClient>>;

  beforeEach(() => {
    vi.clearAllMocks();
    chunkTextWithModeMock.mockImplementation((text: string) => [text]);
  });

  it("propagates payload replyToId through all text chunks", async () => {
    chunkTextWithModeMock.mockImplementation((text: string) => text.split("|"));

    await deliverReplies({
      replies: [{ text: "first|second", replyToId: "reply-1" }],
      target: "chat_id:10",
      client,
      accountId: "default",
      runtime,
      maxBytes: 4096,
      textLimit: 4000,
    });

    expect(sendMessageIMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageIMessageMock).toHaveBeenNthCalledWith(
      1,
      "chat_id:10",
      "first",
      expect.objectContaining({
        client,
        maxBytes: 4096,
        accountId: "default",
        replyToId: "reply-1",
      }),
    );
    expect(sendMessageIMessageMock).toHaveBeenNthCalledWith(
      2,
      "chat_id:10",
      "second",
      expect.objectContaining({
        client,
        maxBytes: 4096,
        accountId: "default",
        replyToId: "reply-1",
      }),
    );
  });

  it("propagates payload replyToId through media sends", async () => {
    await deliverReplies({
      replies: [
        {
          text: "caption",
          mediaUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
          replyToId: "reply-2",
        },
      ],
      target: "chat_id:20",
      client,
      accountId: "acct-2",
      runtime,
      maxBytes: 8192,
      textLimit: 4000,
    });

    expect(sendMessageIMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageIMessageMock).toHaveBeenNthCalledWith(
      1,
      "chat_id:20",
      "caption",
      expect.objectContaining({
        mediaUrl: "https://example.com/a.jpg",
        client,
        maxBytes: 8192,
        accountId: "acct-2",
        replyToId: "reply-2",
      }),
    );
    expect(sendMessageIMessageMock).toHaveBeenNthCalledWith(
      2,
      "chat_id:20",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/b.jpg",
        client,
        maxBytes: 8192,
        accountId: "acct-2",
        replyToId: "reply-2",
      }),
    );
  });

  it("records outbound text and message ids in sent-message cache", async () => {
    const remember = vi.fn();
    chunkTextWithModeMock.mockImplementation((text: string) => text.split("|"));

    await deliverReplies({
      replies: [{ text: "first|second" }],
      target: "chat_id:30",
      client,
      accountId: "acct-3",
      runtime,
      maxBytes: 2048,
      textLimit: 4000,
      sentMessageCache: { remember },
    });

    expect(remember).toHaveBeenCalledWith("acct-3:chat_id:30", { text: "first|second" });
    expect(remember).toHaveBeenCalledWith("acct-3:chat_id:30", {
      text: "first",
      messageId: "imsg-1",
    });
    expect(remember).toHaveBeenCalledWith("acct-3:chat_id:30", {
      text: "second",
      messageId: "imsg-1",
    });
  });

  it("emits message:sent hook with messageId on success", async () => {
    await deliverReplies({
      replies: [{ text: "hi there" }],
      target: "chat_id:40",
      client,
      accountId: "acct-4",
      runtime,
      maxBytes: 4096,
      textLimit: 4000,
      sessionKey: "sess-im",
    });

    expect(emitHookMock).toHaveBeenCalledWith({
      to: "chat_id:40",
      content: "hi there",
      success: true,
      messageId: "imsg-1",
      channelId: "imessage",
      accountId: "acct-4",
      sessionKey: "sess-im",
    });
  });

  it("emits message:sent failure hook when send throws", async () => {
    sendMessageIMessageMock.mockRejectedValueOnce(new Error("delivery failed"));

    await expect(
      deliverReplies({
        replies: [{ text: "oops" }],
        target: "chat_id:50",
        client,
        accountId: "acct-5",
        runtime,
        maxBytes: 4096,
        textLimit: 4000,
        sessionKey: "sess-fail",
      }),
    ).rejects.toThrow("delivery failed");

    expect(emitHookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: "delivery failed",
        channelId: "imessage",
        sessionKey: "sess-fail",
      }),
    );
  });
});
