import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedIMessageAccount } from "./accounts.js";
import { sendMessageIMessage } from "./send.js";

const requestMock = vi.fn();
const stopMock = vi.fn();

const defaultAccount: ResolvedIMessageAccount = {
  accountId: "default",
  enabled: true,
  configured: false,
  config: {},
};

describe("sendMessageIMessage", () => {
  beforeEach(() => {
    requestMock.mockReset().mockResolvedValue({ ok: true });
    stopMock.mockReset().mockResolvedValue(undefined);
  });

  it("sends to chat_id targets", async () => {
    await sendMessageIMessage("chat_id:123", "hi", {
      account: defaultAccount,
      config: {},
      client: {
        request: (...args: unknown[]) => requestMock(...args),
        stop: (...args: unknown[]) => stopMock(...args),
      } as unknown as import("./client.js").IMessageRpcClient,
    });
    const params = requestMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(requestMock).toHaveBeenCalledWith("send", expect.any(Object), expect.any(Object));
    expect(params.chat_id).toBe(123);
    expect(params.text).toBe("hi");
  });

  it("applies sms service prefix", async () => {
    await sendMessageIMessage("sms:+1555", "hello", {
      account: defaultAccount,
      config: {},
      client: {
        request: (...args: unknown[]) => requestMock(...args),
        stop: (...args: unknown[]) => stopMock(...args),
      } as unknown as import("./client.js").IMessageRpcClient,
    });
    const params = requestMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.service).toBe("sms");
    expect(params.to).toBe("+1555");
  });

  it("adds file attachment with placeholder text", async () => {
    await sendMessageIMessage("chat_id:7", "", {
      mediaUrl: "http://x/y.jpg",
      account: defaultAccount,
      config: {},
      resolveAttachmentImpl: async () => ({
        path: "/tmp/imessage-media.jpg",
        contentType: "image/jpeg",
      }),
      client: {
        request: (...args: unknown[]) => requestMock(...args),
        stop: (...args: unknown[]) => stopMock(...args),
      } as unknown as import("./client.js").IMessageRpcClient,
    });
    const params = requestMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.file).toBe("/tmp/imessage-media.jpg");
    expect(params.text).toBe("<media:image>");
  });

  it("returns message id when rpc provides one", async () => {
    requestMock.mockResolvedValue({ ok: true, id: 123 });
    const result = await sendMessageIMessage("chat_id:7", "hello", {
      account: defaultAccount,
      config: {},
      client: {
        request: (...args: unknown[]) => requestMock(...args),
        stop: (...args: unknown[]) => stopMock(...args),
      } as unknown as import("./client.js").IMessageRpcClient,
    });
    expect(result.messageId).toBe("123");
  });

  it("prepends reply tag as the first token when replyToId is provided", async () => {
    await sendMessageIMessage("chat_id:123", "  hello\nworld", {
      replyToId: "abc-123",
      account: defaultAccount,
      config: {},
      client: {
        request: (...args: unknown[]) => requestMock(...args),
        stop: (...args: unknown[]) => stopMock(...args),
      } as unknown as import("./client.js").IMessageRpcClient,
    });
    const params = requestMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.text).toBe("[[reply_to:abc-123]] hello\nworld");
  });

  it("rewrites an existing leading reply tag to keep the requested id first", async () => {
    await sendMessageIMessage("chat_id:123", " [[reply_to:old-id]] hello", {
      replyToId: "new-id",
      account: defaultAccount,
      config: {},
      client: {
        request: (...args: unknown[]) => requestMock(...args),
        stop: (...args: unknown[]) => stopMock(...args),
      } as unknown as import("./client.js").IMessageRpcClient,
    });
    const params = requestMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.text).toBe("[[reply_to:new-id]] hello");
  });

  it("sanitizes replyToId before writing the leading reply tag", async () => {
    await sendMessageIMessage("chat_id:123", "hello", {
      replyToId: " [ab]\n\u0000c\td ] ",
      account: defaultAccount,
      config: {},
      client: {
        request: (...args: unknown[]) => requestMock(...args),
        stop: (...args: unknown[]) => stopMock(...args),
      } as unknown as import("./client.js").IMessageRpcClient,
    });
    const params = requestMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.text).toBe("[[reply_to:abcd]] hello");
  });

  it("skips reply tagging when sanitized replyToId is empty", async () => {
    await sendMessageIMessage("chat_id:123", "hello", {
      replyToId: "[]\u0000\n\r",
      account: defaultAccount,
      config: {},
      client: {
        request: (...args: unknown[]) => requestMock(...args),
        stop: (...args: unknown[]) => stopMock(...args),
      } as unknown as import("./client.js").IMessageRpcClient,
    });
    const params = requestMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.text).toBe("hello");
  });
});
