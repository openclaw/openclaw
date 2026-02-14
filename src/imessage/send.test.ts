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
});
