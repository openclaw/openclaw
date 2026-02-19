import { describe, expect, it, vi, beforeEach } from "vitest";
import { signalCheck, signalRpcRequest, streamSignalEvents } from "./client.js";

// Mock the fetch implementation
const mockFetch = vi.fn();
vi.mock("../infra/fetch.js", () => ({
  resolveFetch: () => mockFetch,
}));

// Mock fetchWithTimeout to delegate to the mockFetch with the original 3-arg test pattern
vi.mock("../utils/fetch-timeout.js", () => ({
  fetchWithTimeout: (url: string, init: RequestInit, timeoutMs: number, fetchFn: Function) =>
    fetchFn(url, init, timeoutMs),
}));

describe("signalCheck (native)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok:true when /api/v1/check returns 200", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
    });

    const result = await signalCheck("http://localhost:8080");
    expect(result).toEqual({ ok: true, status: 200, error: null });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/check",
      expect.objectContaining({ method: "GET" }),
      10000,
    );
  });

  it("returns ok:false when /api/v1/check returns 404", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await signalCheck("http://localhost:8080");
    expect(result).toEqual({ ok: false, status: 404, error: "HTTP 404" });
  });

  it("returns ok:false with error message on fetch failure", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    const result = await signalCheck("http://localhost:8080");
    expect(result).toEqual({ ok: false, status: null, error: "Network error" });
  });

  it("normalizes base URL by removing trailing slash", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await signalCheck("http://localhost:8080/");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/check",
      expect.anything(),
      expect.anything(),
    );
  });

  it("adds http:// prefix when missing", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await signalCheck("localhost:8080");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/check",
      expect.anything(),
      expect.anything(),
    );
  });

  it("respects custom timeout", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await signalCheck("http://localhost:8080", 5000);
    expect(mockFetch).toHaveBeenCalledWith(expect.anything(), expect.anything(), 5000);
  });
});

describe("signalRpcRequest (native JSON-RPC)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("makes JSON-RPC request to /api/v1/rpc", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jsonrpc: "2.0", result: { version: "1.0" }, id: "test" }),
    });

    const result = await signalRpcRequest("listAccounts", undefined, {
      baseUrl: "http://localhost:8080",
    });

    expect(result).toEqual({ version: "1.0" });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/rpc",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
      10000,
    );

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.jsonrpc).toBe("2.0");
    expect(callBody.method).toBe("listAccounts");
    expect(callBody.id).toBeDefined();
  });

  it("sends params in JSON-RPC request", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jsonrpc: "2.0", result: {}, id: "test" }),
    });

    await signalRpcRequest(
      "send",
      { message: "Hello", recipient: ["+15550001111"], account: "+14259798283" },
      { baseUrl: "http://localhost:8080" },
    );

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.params).toEqual({
      message: "Hello",
      recipient: ["+15550001111"],
      account: "+14259798283",
    });
  });

  it("returns undefined for 201 status", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
    });

    const result = await signalRpcRequest(
      "send",
      { message: "test" },
      { baseUrl: "http://localhost:8080" },
    );
    expect(result).toBeUndefined();
  });

  it("throws on JSON-RPC error response", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32600, message: "Invalid Request" },
          id: "test",
        }),
    });

    await expect(
      signalRpcRequest("badMethod", undefined, { baseUrl: "http://localhost:8080" }),
    ).rejects.toThrow("Signal RPC -32600: Invalid Request");
  });

  it("throws on empty response", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
    });

    await expect(
      signalRpcRequest("listAccounts", undefined, { baseUrl: "http://localhost:8080" }),
    ).rejects.toThrow("Signal RPC empty response");
  });

  it("respects custom timeout", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jsonrpc: "2.0", result: {}, id: "test" }),
    });

    await signalRpcRequest("listAccounts", undefined, {
      baseUrl: "http://localhost:8080",
      timeoutMs: 30000,
    });

    expect(mockFetch).toHaveBeenCalledWith(expect.anything(), expect.anything(), 30000);
  });
});

describe("streamSignalEvents (native SSE)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("constructs correct SSE URL with account parameter", async () => {
    // Create a mock readable stream that immediately closes
    const mockReader = {
      read: vi.fn().mockResolvedValue({ done: true }),
    };
    const mockBody = {
      getReader: () => mockReader,
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: mockBody,
    });

    await streamSignalEvents({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      onEvent: vi.fn(),
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        href: "http://localhost:8080/api/v1/events?account=%2B14259798283",
      }),
      expect.objectContaining({
        method: "GET",
        headers: { Accept: "text/event-stream" },
      }),
    );
  });

  it("constructs SSE URL without account parameter when not provided", async () => {
    const mockReader = {
      read: vi.fn().mockResolvedValue({ done: true }),
    };
    const mockBody = {
      getReader: () => mockReader,
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: mockBody,
    });

    await streamSignalEvents({
      baseUrl: "http://localhost:8080",
      onEvent: vi.fn(),
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        href: "http://localhost:8080/api/v1/events",
      }),
      expect.anything(),
    );
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });

    await expect(
      streamSignalEvents({
        baseUrl: "http://localhost:8080",
        onEvent: vi.fn(),
      }),
    ).rejects.toThrow("Signal SSE failed (500 Internal Server Error)");
  });

  it("throws on missing body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
    });

    await expect(
      streamSignalEvents({
        baseUrl: "http://localhost:8080",
        onEvent: vi.fn(),
      }),
    ).rejects.toThrow("Signal SSE failed");
  });

  it("parses SSE events correctly", async () => {
    const events: Array<{ event?: string; data?: string; id?: string }> = [];
    const sseData = 'event: receive\ndata: {"test": true}\nid: 123\n\n';
    const encoder = new TextEncoder();

    let callCount = 0;
    const mockReader = {
      read: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ done: false, value: encoder.encode(sseData) });
        }
        return Promise.resolve({ done: true });
      }),
    };
    const mockBody = {
      getReader: () => mockReader,
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: mockBody,
    });

    await streamSignalEvents({
      baseUrl: "http://localhost:8080",
      onEvent: (evt) => events.push(evt),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      event: "receive",
      data: '{"test": true}',
      id: "123",
    });
  });

  it("handles multi-line data in SSE events", async () => {
    const events: Array<{ event?: string; data?: string }> = [];
    const sseData = "event: receive\ndata: line1\ndata: line2\n\n";
    const encoder = new TextEncoder();

    let callCount = 0;
    const mockReader = {
      read: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ done: false, value: encoder.encode(sseData) });
        }
        return Promise.resolve({ done: true });
      }),
    };
    const mockBody = {
      getReader: () => mockReader,
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: mockBody,
    });

    await streamSignalEvents({
      baseUrl: "http://localhost:8080",
      onEvent: (evt) => events.push(evt),
    });

    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("line1\nline2");
  });

  it("ignores SSE comment lines", async () => {
    const events: Array<{ event?: string; data?: string }> = [];
    const sseData = ": this is a comment\nevent: receive\ndata: test\n\n";
    const encoder = new TextEncoder();

    let callCount = 0;
    const mockReader = {
      read: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ done: false, value: encoder.encode(sseData) });
        }
        return Promise.resolve({ done: true });
      }),
    };
    const mockBody = {
      getReader: () => mockReader,
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: mockBody,
    });

    await streamSignalEvents({
      baseUrl: "http://localhost:8080",
      onEvent: (evt) => events.push(evt),
    });

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("receive");
  });

  it("respects abort signal", async () => {
    const abortController = new AbortController();
    mockFetch.mockImplementation(() => {
      // Simulate abort
      abortController.abort();
      throw new DOMException("Aborted", "AbortError");
    });

    await expect(
      streamSignalEvents({
        baseUrl: "http://localhost:8080",
        abortSignal: abortController.signal,
        onEvent: vi.fn(),
      }),
    ).rejects.toThrow();
  });
});

describe("normalizeBaseUrl edge cases (native)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles https URLs", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await signalCheck("https://signal.example.com");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://signal.example.com/api/v1/check",
      expect.anything(),
      expect.anything(),
    );
  });

  it("handles URLs with ports", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await signalCheck("http://192.168.1.100:9922");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://192.168.1.100:9922/api/v1/check",
      expect.anything(),
      expect.anything(),
    );
  });

  it("handles multiple trailing slashes", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await signalCheck("http://localhost:8080///");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/check",
      expect.anything(),
      expect.anything(),
    );
  });
});
