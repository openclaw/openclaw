import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedIMessageAccount } from "./accounts.js";
import type { IMessageRpcClient } from "./client.js";
import { sendMessageIMessage } from "./send.js";

const requestMock = vi.fn();
const stopMock = vi.fn();

const defaultAccount: ResolvedIMessageAccount = {
  accountId: "default",
  enabled: true,
  configured: false,
  config: {},
};

function createClient(): IMessageRpcClient {
  return {
    request: (...args: unknown[]) => requestMock(...args),
    stop: (...args: unknown[]) => stopMock(...args),
  } as unknown as IMessageRpcClient;
}

async function sendWithDefaults(
  to: string,
  text: string,
  opts: Parameters<typeof sendMessageIMessage>[2] = {},
) {
  return await sendMessageIMessage(to, text, {
    account: defaultAccount,
    config: {},
    client: createClient(),
    ...opts,
  });
}

function getSentParams() {
  return requestMock.mock.calls[0]?.[1] as Record<string, unknown>;
}

describe("sendMessageIMessage", () => {
  beforeEach(() => {
    requestMock.mockClear().mockResolvedValue({ ok: true });
    stopMock.mockClear().mockResolvedValue(undefined);
  });

  it("sends to chat_id targets", async () => {
    await sendWithDefaults("chat_id:123", "hi");
    const params = getSentParams();
    expect(requestMock).toHaveBeenCalledWith("send", expect.any(Object), expect.any(Object));
    expect(params.chat_id).toBe(123);
    expect(params.text).toBe("hi");
  });

  it("applies sms service prefix", async () => {
    await sendWithDefaults("sms:+1555", "hello");
    const params = getSentParams();
    expect(params.service).toBe("sms");
    expect(params.to).toBe("+1555");
  });

  it("adds file attachment with placeholder text", async () => {
    await sendWithDefaults("chat_id:7", "", {
      mediaUrl: "http://x/y.jpg",
      resolveAttachmentImpl: async () => ({
        path: "/tmp/imessage-media.jpg",
        contentType: "image/jpeg",
      }),
    });
    const params = getSentParams();
    expect(params.file).toBe("/tmp/imessage-media.jpg");
    expect(params.text).toBe("<media:image>");
  });

  it("normalizes mixed-case parameterized MIME for attachment placeholder text", async () => {
    await sendWithDefaults("chat_id:7", "", {
      mediaUrl: "http://x/voice",
      resolveAttachmentImpl: async () => ({
        path: "/tmp/imessage-media.ogg",
        contentType: " Audio/Ogg; codecs=opus ",
      }),
    });
    const params = getSentParams();
    expect(params.file).toBe("/tmp/imessage-media.ogg");
    expect(params.text).toBe("<media:audio>");
  });

  it("returns message id when rpc provides one", async () => {
    requestMock.mockResolvedValue({ ok: true, id: 123 });
    const result = await sendWithDefaults("chat_id:7", "hello");
    expect(result.messageId).toBe("123");
  });

  it("strips reply tags instead of embedding them as literal text", async () => {
    await sendWithDefaults("chat_id:123", "  hello\nworld", {
      replyToId: "abc-123",
    });
    const params = getSentParams();
    expect(params.text).toBe("hello\nworld");
  });

  it("strips existing reply_to tags from AI output", async () => {
    await sendWithDefaults("chat_id:123", "hello [[reply_to:old-id]] world");
    const params = getSentParams();
    expect(params.text).toBe("hello  world");
  });

  it("strips reply_to_current tags from AI output", async () => {
    await sendWithDefaults("chat_id:123", "[[reply_to_current]] hello");
    const params = getSentParams();
    expect(params.text).toBe("hello");
  });

  it("preserves text content when no reply tags are present", async () => {
    await sendWithDefaults("chat_id:123", "hello world");
    const params = getSentParams();
    expect(params.text).toBe("hello world");
  });

  it("normalizes string message_id values from rpc result", async () => {
    requestMock.mockResolvedValue({ ok: true, message_id: "  guid-1  " });
    const result = await sendWithDefaults("chat_id:7", "hello");
    expect(result.messageId).toBe("guid-1");
  });

  it("does not stop an injected client", async () => {
    await sendWithDefaults("chat_id:123", "hello");
    expect(stopMock).not.toHaveBeenCalled();
  });
});
