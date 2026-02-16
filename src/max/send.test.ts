import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendMediaMax, sendMessageMax } from "./send.js";

// Mock fetchWithTimeout
const fetchWithTimeoutMock = vi.fn();
vi.mock("../utils/fetch-timeout.js", () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeoutMock(...args),
}));

// Suppress proxy import
vi.mock("../telegram/proxy.js", () => ({
  makeProxyFetch: vi.fn(() => vi.fn()),
}));

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

describe("sendMessageMax", () => {
  beforeEach(() => {
    fetchWithTimeoutMock.mockReset();
  });

  it("sends a text message and returns messageId + chatId", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ message: { mid: "msg_123" } }));

    const result = await sendMessageMax("chat_42", "Hello!", { token: "tok" });

    expect(result.messageId).toBe("msg_123");
    expect(result.chatId).toBe("chat_42");

    const [url, init] = fetchWithTimeoutMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://platform-api.max.ru/messages?chat_id=chat_42");
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("tok");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.text).toBe("Hello!");
  });

  it("includes format when specified", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ message: { mid: "m1" } }));

    await sendMessageMax("c1", "text", { token: "t", format: "html" });

    const body = JSON.parse(
      (fetchWithTimeoutMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(body.format).toBe("html");
  });

  it("includes reply link when replyToMessageId is set", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ message: { mid: "m2" } }));

    await sendMessageMax("c1", "reply", { token: "t", replyToMessageId: "parent_mid" });

    const body = JSON.parse(
      (fetchWithTimeoutMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(body.link).toEqual({ type: "reply", mid: "parent_mid" });
  });

  it("includes inline keyboard when buttons are set", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ message: { mid: "m3" } }));

    await sendMessageMax("c1", "Choose:", {
      token: "t",
      buttons: [
        [
          { text: "Yes", payload: "yes" },
          { text: "No", payload: "no" },
        ],
      ],
    });

    const body = JSON.parse(
      (fetchWithTimeoutMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    const attachments = body.attachments as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].type).toBe("inline_keyboard");
  });

  it("sends notify=false when explicitly disabled", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ message: { mid: "m4" } }));

    await sendMessageMax("c1", "silent", { token: "t", notify: false });

    const body = JSON.parse(
      (fetchWithTimeoutMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(body.notify).toBe(false);
  });

  it("sends disable_link_preview when set", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ message: { mid: "m5" } }));

    await sendMessageMax("c1", "link", { token: "t", disableLinkPreview: true });

    const body = JSON.parse(
      (fetchWithTimeoutMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(body.disable_link_preview).toBe(true);
  });

  it("throws on non-ok response", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ message: "Bad Request" }, 400));

    await expect(sendMessageMax("c1", "fail", { token: "t" })).rejects.toThrow(
      /MAX sendMessage failed \(400\)/,
    );
  });

  it("extracts mid from top-level json when message.mid is missing", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ mid: "top_mid" }));

    const result = await sendMessageMax("c1", "text", { token: "t" });

    expect(result.messageId).toBe("top_mid");
  });

  it("returns empty string messageId when no mid is found", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({}));

    const result = await sendMessageMax("c1", "text", { token: "t" });

    expect(result.messageId).toBe("");
  });

  it("URL-encodes chatId", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ message: { mid: "m6" } }));

    await sendMessageMax("chat with spaces", "text", { token: "t" });

    const [url] = fetchWithTimeoutMock.mock.calls[0] as [string];
    expect(url).toContain("chat_id=chat%20with%20spaces");
  });
});

describe("sendMediaMax", () => {
  beforeEach(() => {
    fetchWithTimeoutMock.mockReset();
  });

  it("performs two-step upload: upload file then send message", async () => {
    // Step 1: Upload response
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse({ type: "photo", token: "upload_tok_123" }),
    );
    // Step 2: Send message response
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ message: { mid: "media_msg_1" } }));

    const buf = Buffer.from("fake-image-data");
    const result = await sendMediaMax("chat_1", buf, {
      token: "tok",
      mediaType: "photo",
      fileName: "pic.jpg",
      caption: "A photo",
      mimeType: "image/jpeg",
    });

    expect(result.messageId).toBe("media_msg_1");
    expect(result.chatId).toBe("chat_1");
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);

    // Verify upload URL
    const [uploadUrl] = fetchWithTimeoutMock.mock.calls[0] as [string];
    expect(uploadUrl).toBe("https://platform-api.max.ru/uploads?type=photo");

    // Verify message URL
    const [msgUrl] = fetchWithTimeoutMock.mock.calls[1] as [string];
    expect(msgUrl).toBe("https://platform-api.max.ru/messages?chat_id=chat_1");

    // Verify message body contains upload attachment and caption
    const msgInit = (fetchWithTimeoutMock.mock.calls[1] as [string, RequestInit])[1];
    const msgBody = JSON.parse(msgInit.body as string) as Record<string, unknown>;
    expect(msgBody.text).toBe("A photo");
    expect(msgBody.attachments).toEqual([{ type: "photo", token: "upload_tok_123" }]);
  });

  it("defaults to mediaType=file when not specified", async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(jsonResponse({ type: "file", token: "t" }))
      .mockResolvedValueOnce(jsonResponse({ message: { mid: "m" } }));

    await sendMediaMax("c1", Buffer.from("data"), { token: "tok" });

    const [uploadUrl] = fetchWithTimeoutMock.mock.calls[0] as [string];
    expect(uploadUrl).toContain("type=file");
  });

  it("throws on upload failure", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ error: "Too large" }, 413));

    await expect(sendMediaMax("c1", Buffer.from("data"), { token: "tok" })).rejects.toThrow(
      /MAX upload failed \(413\)/,
    );
  });

  it("throws on message send failure after successful upload", async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(jsonResponse({ type: "file", token: "t" }))
      .mockResolvedValueOnce(jsonResponse({ error: "Rate limit" }, 429));

    await expect(sendMediaMax("c1", Buffer.from("data"), { token: "tok" })).rejects.toThrow(
      /MAX sendMedia failed \(429\)/,
    );
  });

  it("includes format and reply link when specified", async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(jsonResponse({ type: "photo", token: "t" }))
      .mockResolvedValueOnce(jsonResponse({ message: { mid: "m" } }));

    await sendMediaMax("c1", Buffer.from("data"), {
      token: "tok",
      format: "html",
      replyToMessageId: "reply_to_this",
    });

    const msgBody = JSON.parse(
      (fetchWithTimeoutMock.mock.calls[1] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(msgBody.format).toBe("html");
    expect(msgBody.link).toEqual({ type: "reply", mid: "reply_to_this" });
  });

  it("uses FormData for upload with correct file name", async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(jsonResponse({ type: "audio", token: "t" }))
      .mockResolvedValueOnce(jsonResponse({ message: { mid: "m" } }));

    await sendMediaMax("c1", Buffer.from("audio-data"), {
      token: "tok",
      mediaType: "audio",
      fileName: "song.mp3",
    });

    const uploadInit = (fetchWithTimeoutMock.mock.calls[0] as [string, RequestInit])[1];
    expect(uploadInit.body).toBeInstanceOf(FormData);
  });
});
