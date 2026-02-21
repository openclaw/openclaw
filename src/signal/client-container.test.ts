import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  containerCheck,
  containerRestRequest,
  containerSendMessage,
  containerSendTyping,
  containerSendReceipt,
  containerFetchAttachment,
  containerSendReaction,
  containerRemoveReaction,
} from "./client-container.js";

// Mock the fetch implementation
const mockFetch = vi.fn();
vi.mock("../infra/fetch.js", () => ({
  resolveFetch: () => mockFetch,
}));

// Mock WebSocket (not testing streamContainerEvents in unit tests due to complexity)
vi.mock("ws", () => ({
  default: class MockWebSocket {
    on() {}
    close() {}
  },
}));

describe("containerCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok:true when /v1/about returns 200", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
    });

    const result = await containerCheck("http://localhost:8080");
    expect(result).toEqual({ ok: true, status: 200, error: null });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/v1/about",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns ok:false when /v1/about returns 404", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await containerCheck("http://localhost:8080");
    expect(result).toEqual({ ok: false, status: 404, error: "HTTP 404" });
  });

  it("returns ok:false with error message on fetch failure", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    const result = await containerCheck("http://localhost:8080");
    expect(result).toEqual({ ok: false, status: null, error: "Network error" });
  });

  it("normalizes base URL by removing trailing slash", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await containerCheck("http://localhost:8080/");
    expect(mockFetch).toHaveBeenCalledWith("http://localhost:8080/v1/about", expect.anything());
  });

  it("adds http:// prefix when missing", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await containerCheck("localhost:8080");
    expect(mockFetch).toHaveBeenCalledWith("http://localhost:8080/v1/about", expect.anything());
  });
});

describe("containerRestRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("makes GET request with correct endpoint", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ version: "1.0" }),
    });

    const result = await containerRestRequest("/v1/about", { baseUrl: "http://localhost:8080" });
    expect(result).toEqual({ version: "1.0" });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/v1/about",
      expect.objectContaining({
        method: "GET",
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("makes POST request with body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
    });

    await containerRestRequest("/v2/send", { baseUrl: "http://localhost:8080" }, "POST", {
      message: "test",
      number: "+1234567890",
      recipients: ["+1234567890"],
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/v2/send",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          message: "test",
          number: "+1234567890",
          recipients: ["+1234567890"],
        }),
      }),
    );
  });

  it("returns undefined for 201 status", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
    });

    const result = await containerRestRequest(
      "/v2/send",
      { baseUrl: "http://localhost:8080" },
      "POST",
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined for 204 status", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    });

    const result = await containerRestRequest(
      "/v1/typing-indicator/+1234567890",
      { baseUrl: "http://localhost:8080" },
      "PUT",
    );
    expect(result).toBeUndefined();
  });

  it("throws error on non-ok response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "Server error details",
    });

    await expect(
      containerRestRequest("/v2/send", { baseUrl: "http://localhost:8080" }, "POST"),
    ).rejects.toThrow("Signal REST 500: Server error details");
  });

  it("handles empty response body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
    });

    const result = await containerRestRequest("/v1/about", { baseUrl: "http://localhost:8080" });
    expect(result).toBeUndefined();
  });

  it("respects custom timeout by using abort signal", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "{}",
    });

    await containerRestRequest("/v1/about", { baseUrl: "http://localhost:8080", timeoutMs: 5000 });

    // The timeout is enforced via AbortController, so we verify the call was made with a signal
    expect(mockFetch).toHaveBeenCalled();
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[1].signal).toBeDefined();
  });
});

describe("containerSendMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends message to recipients", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ timestamp: 1700000000000 }),
    });

    const result = await containerSendMessage({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipients: ["+15550001111"],
      message: "Hello world",
    });

    expect(result).toEqual({ timestamp: 1700000000000 });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/v2/send",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          message: "Hello world",
          number: "+14259798283",
          recipients: ["+15550001111"],
        }),
      }),
    );
  });

  it("includes text styles when provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({}),
    });

    await containerSendMessage({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipients: ["+15550001111"],
      message: "Bold text",
      textStyles: [{ start: 0, length: 4, style: "BOLD" }],
    });

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body["text_style"]).toEqual(["0:4:BOLD"]);
  });

  it("includes attachments as base64 data URIs", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");

    // Create a temp file with known content
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "signal-test-"));
    const tmpFile = path.join(tmpDir, "test-image.jpg");
    const content = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic bytes
    await fs.writeFile(tmpFile, content);

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({}),
    });

    await containerSendMessage({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipients: ["+15550001111"],
      message: "Photo",
      attachments: [tmpFile],
    });

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.attachments).toBeUndefined();
    expect(body.base64_attachments).toBeDefined();
    expect(body.base64_attachments).toHaveLength(1);
    expect(body.base64_attachments[0]).toMatch(
      /^data:image\/jpeg;filename=test-image\.jpg;base64,/,
    );

    // Cleanup
    await fs.rm(tmpDir, { recursive: true });
  });
});

describe("containerSendTyping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends typing indicator with PUT", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    });

    const result = await containerSendTyping({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
    });

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/v1/typing-indicator/%2B14259798283",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ recipient: "+15550001111" }),
      }),
    );
  });

  it("stops typing indicator with DELETE", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    });

    await containerSendTyping({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
      stop: true,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("containerSendReceipt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends read receipt", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    });

    const result = await containerSendReceipt({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
      timestamp: 1700000000000,
    });

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/v1/receipts/%2B14259798283",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          recipient: "+15550001111",
          timestamp: 1700000000000,
          receipt_type: "read",
        }),
      }),
    );
  });

  it("sends viewed receipt when type specified", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    });

    await containerSendReceipt({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
      timestamp: 1700000000000,
      type: "viewed",
    });

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.receipt_type).toBe("viewed");
  });
});

describe("containerFetchAttachment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches attachment binary", async () => {
    const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => binaryData.buffer,
    });

    const result = await containerFetchAttachment("attachment-123", {
      baseUrl: "http://localhost:8080",
    });

    expect(result).toBeInstanceOf(Buffer);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/v1/attachments/attachment-123",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns null on non-ok response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await containerFetchAttachment("attachment-123", {
      baseUrl: "http://localhost:8080",
    });

    expect(result).toBeNull();
  });

  it("encodes attachment ID in URL", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    await containerFetchAttachment("path/with/slashes", {
      baseUrl: "http://localhost:8080",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/v1/attachments/path%2Fwith%2Fslashes",
      expect.anything(),
    );
  });
});

describe("normalizeBaseUrl edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws error for empty base URL", async () => {
    await expect(containerCheck("")).rejects.toThrow("Signal base URL is required");
  });

  it("throws error for whitespace-only base URL", async () => {
    await expect(containerCheck("   ")).rejects.toThrow("Signal base URL is required");
  });

  it("handles https URLs", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await containerCheck("https://signal.example.com");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://signal.example.com/v1/about",
      expect.anything(),
    );
  });

  it("handles URLs with ports", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await containerCheck("http://192.168.1.100:9922");
    expect(mockFetch).toHaveBeenCalledWith("http://192.168.1.100:9922/v1/about", expect.anything());
  });
});

describe("containerRestRequest edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles DELETE method", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    });

    await containerRestRequest(
      "/v1/some-resource/123",
      { baseUrl: "http://localhost:8080" },
      "DELETE",
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/v1/some-resource/123",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("handles error response with empty body", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "",
    });

    await expect(
      containerRestRequest("/v2/send", { baseUrl: "http://localhost:8080" }, "POST"),
    ).rejects.toThrow("Signal REST 500: Internal Server Error");
  });

  it("handles JSON parse errors gracefully", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "not-valid-json",
    });

    await expect(
      containerRestRequest("/v1/about", { baseUrl: "http://localhost:8080" }),
    ).rejects.toThrow();
  });
});

describe("containerSendReaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends reaction to recipient", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ timestamp: 1700000000000 }),
    });

    const result = await containerSendReaction({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
      emoji: "👍",
      targetAuthor: "+15550001111",
      targetTimestamp: 1699999999999,
    });

    expect(result).toEqual({ timestamp: 1700000000000 });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/v1/reactions/%2B14259798283",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          recipient: "+15550001111",
          reaction: "👍",
          target_author: "+15550001111",
          timestamp: 1699999999999,
        }),
      }),
    );
  });

  it("includes group_id when provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({}),
    });

    await containerSendReaction({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
      emoji: "❤️",
      targetAuthor: "+15550001111",
      targetTimestamp: 1699999999999,
      groupId: "group-123",
    });

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.group_id).toBe("group-123");
  });
});

describe("containerRemoveReaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes reaction with DELETE", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ timestamp: 1700000000000 }),
    });

    const result = await containerRemoveReaction({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
      emoji: "👍",
      targetAuthor: "+15550001111",
      targetTimestamp: 1699999999999,
    });

    expect(result).toEqual({ timestamp: 1700000000000 });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/v1/reactions/%2B14259798283",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({
          recipient: "+15550001111",
          reaction: "👍",
          target_author: "+15550001111",
          timestamp: 1699999999999,
        }),
      }),
    );
  });

  it("includes group_id when provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({}),
    });

    await containerRemoveReaction({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
      emoji: "❤️",
      targetAuthor: "+15550001111",
      targetTimestamp: 1699999999999,
      groupId: "group-123",
    });

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.group_id).toBe("group-123");
  });
});
