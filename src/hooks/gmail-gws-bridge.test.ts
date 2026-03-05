import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNdjsonLineHandler,
  postToHookUrl,
  transformGmailApiMessage,
} from "./gmail-gws-bridge.js";

describe("transformGmailApiMessage", () => {
  it("extracts id, from, subject, snippet from a Gmail API message", () => {
    const msg = {
      id: "abc123",
      snippet: "Hey there...",
      payload: {
        headers: [
          { name: "From", value: "alice@example.com" },
          { name: "Subject", value: "Hello" },
        ],
      },
    };
    const result = transformGmailApiMessage(msg);
    expect(result).toEqual({
      messages: [
        {
          id: "abc123",
          from: "alice@example.com",
          subject: "Hello",
          snippet: "Hey there...",
          body: "",
        },
      ],
    });
  });

  it("extracts text/plain body from payload", () => {
    const body = Buffer.from("Hello world!").toString("base64url");
    const msg = {
      id: "msg1",
      snippet: "",
      payload: {
        mimeType: "text/plain",
        headers: [],
        body: { data: body },
      },
    };
    const result = transformGmailApiMessage(msg, { includeBody: true });
    expect(result.messages[0]?.body).toBe("Hello world!");
  });

  it("finds text/plain in multipart message", () => {
    const body = Buffer.from("nested body").toString("base64url");
    const msg = {
      id: "msg2",
      snippet: "",
      payload: {
        mimeType: "multipart/alternative",
        headers: [],
        parts: [
          { mimeType: "text/html", body: { data: "" } },
          { mimeType: "text/plain", body: { data: body } },
        ],
      },
    };
    const result = transformGmailApiMessage(msg, { includeBody: true });
    expect(result.messages[0]?.body).toBe("nested body");
  });

  it("truncates body to maxBytes", () => {
    const longText = "a".repeat(100);
    const body = Buffer.from(longText).toString("base64url");
    const msg = {
      id: "msg3",
      snippet: "",
      payload: {
        mimeType: "text/plain",
        headers: [],
        body: { data: body },
      },
    };
    const result = transformGmailApiMessage(msg, { includeBody: true, maxBytes: 10 });
    expect(result.messages[0]?.body).toBe("a".repeat(10));
  });

  it("skips body when includeBody is false", () => {
    const body = Buffer.from("secret").toString("base64url");
    const msg = {
      id: "msg4",
      snippet: "",
      payload: {
        mimeType: "text/plain",
        headers: [],
        body: { data: body },
      },
    };
    const result = transformGmailApiMessage(msg, { includeBody: false });
    expect(result.messages[0]?.body).toBe("");
  });

  it("handles missing payload gracefully", () => {
    const msg = { id: "msg5", snippet: "test" };
    const result = transformGmailApiMessage(msg);
    expect(result.messages[0]).toEqual({
      id: "msg5",
      from: "",
      subject: "",
      snippet: "test",
      body: "",
    });
  });

  it("handles case-insensitive header lookup", () => {
    const msg = {
      id: "msg6",
      snippet: "",
      payload: {
        headers: [
          { name: "from", value: "bob@example.com" },
          { name: "SUBJECT", value: "Test" },
        ],
      },
    };
    const result = transformGmailApiMessage(msg);
    expect(result.messages[0]?.from).toBe("bob@example.com");
    expect(result.messages[0]?.subject).toBe("Test");
  });
});

describe("postToHookUrl", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends POST with correct headers and body", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("ok", { status: 200 }));

    const payload = { messages: [{ id: "1", from: "a", subject: "s", snippet: "sn", body: "b" }] };
    await postToHookUrl(payload, "http://localhost:18789/hooks/gmail", "tok123");

    expect(globalThis.fetch).toHaveBeenCalledWith("http://localhost:18789/hooks/gmail", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tok123",
      },
      body: JSON.stringify(payload),
    });
  });

  it("throws on non-ok response", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("fail", { status: 401, statusText: "Unauthorized" }),
    );

    const payload = { messages: [{ id: "1", from: "", subject: "", snippet: "", body: "" }] };
    await expect(
      postToHookUrl(payload, "http://localhost:18789/hooks/gmail", "bad-token"),
    ).rejects.toThrow("Hook POST failed: 401 Unauthorized");
  });
});

describe("createNdjsonLineHandler", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses JSON line, transforms, and POSTs", () => {
    const handler = createNdjsonLineHandler({
      hookUrl: "http://localhost/hooks/gmail",
      hookToken: "tok",
      includeBody: true,
      maxBytes: 20000,
    });

    const line = JSON.stringify({
      id: "msg1",
      snippet: "hi",
      payload: {
        headers: [
          { name: "From", value: "alice@example.com" },
          { name: "Subject", value: "Test" },
        ],
      },
    });

    handler(line);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    expect(url).toBe("http://localhost/hooks/gmail");
    const body = JSON.parse((opts as RequestInit).body as string) as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, string>>;
    expect(messages[0]?.id).toBe("msg1");
    expect(messages[0]?.from).toBe("alice@example.com");
  });

  it("ignores empty lines", () => {
    const handler = createNdjsonLineHandler({
      hookUrl: "http://localhost/hooks/gmail",
      hookToken: "tok",
      includeBody: true,
      maxBytes: 20000,
    });

    handler("");
    handler("   ");

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("ignores non-JSON lines", () => {
    const handler = createNdjsonLineHandler({
      hookUrl: "http://localhost/hooks/gmail",
      hookToken: "tok",
      includeBody: true,
      maxBytes: 20000,
    });

    handler("not json at all");

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
