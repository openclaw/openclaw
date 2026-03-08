import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  signalRpcRequest,
  detectSignalApiMode,
  signalCheck,
  streamSignalEvents,
  fetchAttachment,
} from "./client-adapter.js";

// Mock the native client
vi.mock("./client.js", () => ({
  signalCheck: vi.fn(),
  signalRpcRequest: vi.fn(),
  streamSignalEvents: vi.fn(),
}));

// Mock the container client
vi.mock("./client-container.js", () => ({
  containerCheck: vi.fn(),
  containerRpcRequest: vi.fn(),
  containerFetchAttachment: vi.fn(),
  streamContainerEvents: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));
import { loadConfig } from "../config/config.js";
import {
  containerCheck,
  containerRpcRequest,
  containerFetchAttachment,
  streamContainerEvents,
} from "./client-container.js";
import {
  signalCheck as nativeCheck,
  signalRpcRequest as nativeRpcRequest,
  streamSignalEvents as nativeStreamEvents,
} from "./client.js";

const mockNativeCheck = vi.mocked(nativeCheck);
const mockNativeRpcRequest = vi.mocked(nativeRpcRequest);
const mockNativeStreamEvents = vi.mocked(nativeStreamEvents);
const mockContainerCheck = vi.mocked(containerCheck);
const mockContainerRpcRequest = vi.mocked(containerRpcRequest);
const mockContainerFetchAttachment = vi.mocked(containerFetchAttachment);
const mockStreamContainerEvents = vi.mocked(streamContainerEvents);
const mockLoadConfig = vi.mocked(loadConfig);

function setApiMode(mode: "native" | "container" | "auto") {
  mockLoadConfig.mockReturnValue({
    channels: {
      signal: {
        apiMode: mode,
      },
    },
  });
}

describe("detectSignalApiMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApiMode("native");
  });

  it("returns native when native endpoint responds", async () => {
    mockNativeCheck.mockResolvedValue({ ok: true, status: 200 });
    mockContainerCheck.mockResolvedValue({ ok: false, status: 404 });

    const result = await detectSignalApiMode("http://localhost:8080");
    expect(result).toBe("native");
  });

  it("returns container when only container endpoint responds", async () => {
    mockNativeCheck.mockResolvedValue({ ok: false, status: 404 });
    mockContainerCheck.mockResolvedValue({ ok: true, status: 200 });

    const result = await detectSignalApiMode("http://localhost:8080");
    expect(result).toBe("container");
  });

  it("prefers native when both endpoints respond", async () => {
    mockNativeCheck.mockResolvedValue({ ok: true, status: 200 });
    mockContainerCheck.mockResolvedValue({ ok: true, status: 200 });

    const result = await detectSignalApiMode("http://localhost:8080");
    expect(result).toBe("native");
  });

  it("throws error when neither endpoint responds", async () => {
    mockNativeCheck.mockResolvedValue({ ok: false, status: null, error: "Connection refused" });
    mockContainerCheck.mockResolvedValue({ ok: false, status: null, error: "Connection refused" });

    await expect(detectSignalApiMode("http://localhost:8080")).rejects.toThrow(
      "Signal API not reachable at http://localhost:8080",
    );
  });

  it("handles exceptions from check functions", async () => {
    mockNativeCheck.mockRejectedValue(new Error("Network error"));
    mockContainerCheck.mockRejectedValue(new Error("Network error"));

    await expect(detectSignalApiMode("http://localhost:8080")).rejects.toThrow(
      "Signal API not reachable",
    );
  });

  it("respects timeout parameter", async () => {
    mockNativeCheck.mockResolvedValue({ ok: true, status: 200 });
    mockContainerCheck.mockResolvedValue({ ok: false });

    await detectSignalApiMode("http://localhost:8080", 5000);
    expect(mockNativeCheck).toHaveBeenCalledWith("http://localhost:8080", 5000);
    expect(mockContainerCheck).toHaveBeenCalledWith("http://localhost:8080", 5000);
  });
});

describe("signalRpcRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApiMode("native");
  });

  it("routes to native JSON-RPC for native mode", async () => {
    mockNativeRpcRequest.mockResolvedValue({ timestamp: 1700000000000 });

    const result = await signalRpcRequest(
      "send",
      { message: "Hello", account: "+14259798283", recipient: ["+15550001111"] },
      { baseUrl: "http://localhost:8080" },
    );

    expect(result).toEqual({ timestamp: 1700000000000 });
    expect(mockNativeRpcRequest).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ message: "Hello" }),
      expect.objectContaining({ baseUrl: "http://localhost:8080" }),
    );
    expect(mockContainerRpcRequest).not.toHaveBeenCalled();
  });

  it("routes to container RPC for container mode", async () => {
    setApiMode("container");
    mockContainerRpcRequest.mockResolvedValue({ timestamp: 1700000000000 });

    const result = await signalRpcRequest(
      "send",
      { message: "Hello", account: "+14259798283", recipient: ["+15550001111"] },
      { baseUrl: "http://localhost:8080" },
    );

    expect(result).toEqual({ timestamp: 1700000000000 });
    expect(mockContainerRpcRequest).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ message: "Hello" }),
      expect.objectContaining({ baseUrl: "http://localhost:8080" }),
    );
    expect(mockNativeRpcRequest).not.toHaveBeenCalled();
  });

  it("passes all RPC methods through to native", async () => {
    mockNativeRpcRequest.mockResolvedValue({});

    await signalRpcRequest(
      "sendTyping",
      { account: "+1", recipient: ["+2"] },
      { baseUrl: "http://localhost:8080" },
    );
    expect(mockNativeRpcRequest).toHaveBeenCalledWith(
      "sendTyping",
      expect.anything(),
      expect.anything(),
    );
  });

  it("passes all RPC methods through to container", async () => {
    setApiMode("container");
    mockContainerRpcRequest.mockResolvedValue({});

    await signalRpcRequest(
      "sendReceipt",
      { account: "+1", recipient: ["+2"] },
      { baseUrl: "http://localhost:8080" },
    );
    expect(mockContainerRpcRequest).toHaveBeenCalledWith(
      "sendReceipt",
      expect.anything(),
      expect.anything(),
    );
  });
});

describe("signalCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApiMode("native");
  });

  it("uses native check for native mode", async () => {
    mockNativeCheck.mockResolvedValue({ ok: true, status: 200 });

    const result = await signalCheck("http://localhost:8080");

    expect(result).toEqual({ ok: true, status: 200 });
    expect(mockNativeCheck).toHaveBeenCalledWith("http://localhost:8080", 10000);
    expect(mockContainerCheck).not.toHaveBeenCalled();
  });

  it("uses container check for container mode", async () => {
    setApiMode("container");
    mockContainerCheck.mockResolvedValue({ ok: true, status: 200 });

    const result = await signalCheck("http://localhost:8080");

    expect(result).toEqual({ ok: true, status: 200 });
    expect(mockContainerCheck).toHaveBeenCalledWith("http://localhost:8080", 10000);
    expect(mockNativeCheck).not.toHaveBeenCalled();
  });

  it("respects timeout parameter", async () => {
    mockNativeCheck.mockResolvedValue({ ok: true });

    await signalCheck("http://localhost:8080", 5000);

    expect(mockNativeCheck).toHaveBeenCalledWith("http://localhost:8080", 5000);
  });
});

describe("streamSignalEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApiMode("native");
  });

  it("uses native SSE for native mode", async () => {
    mockNativeStreamEvents.mockResolvedValue();

    const onEvent = vi.fn();
    await streamSignalEvents({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      onEvent,
    });

    expect(mockNativeStreamEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://localhost:8080",
        account: "+14259798283",
      }),
    );
    expect(mockStreamContainerEvents).not.toHaveBeenCalled();
  });

  it("uses container WebSocket for container mode", async () => {
    setApiMode("container");
    mockStreamContainerEvents.mockResolvedValue();

    const onEvent = vi.fn();
    await streamSignalEvents({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      onEvent,
    });

    expect(mockStreamContainerEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://localhost:8080",
        account: "+14259798283",
      }),
    );
    expect(mockNativeStreamEvents).not.toHaveBeenCalled();
  });

  it("passes native SSE events through unchanged", async () => {
    const payload = { envelope: { sourceNumber: "+1555000111" } };
    mockNativeStreamEvents.mockImplementation(async (params) => {
      params.onEvent({ event: "receive", data: JSON.stringify(payload) });
    });

    const events: unknown[] = [];
    await streamSignalEvents({
      baseUrl: "http://localhost:8080",
      onEvent: (evt) => events.push(evt),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: "receive", data: JSON.stringify(payload) });
  });

  it("converts container events to SSE-like receive events", async () => {
    setApiMode("container");
    mockStreamContainerEvents.mockImplementation(async (params) => {
      params.onEvent({ envelope: { sourceNumber: "+1555000111" } });
    });

    const events: unknown[] = [];
    await streamSignalEvents({
      baseUrl: "http://localhost:8080",
      onEvent: (evt) => events.push(evt),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      event: "receive",
      data: JSON.stringify({ envelope: { sourceNumber: "+1555000111" } }),
    });
  });

  it("passes abort signal to underlying stream", async () => {
    mockNativeStreamEvents.mockResolvedValue();

    const abortController = new AbortController();
    await streamSignalEvents({
      baseUrl: "http://localhost:8080",
      abortSignal: abortController.signal,
      onEvent: vi.fn(),
    });

    expect(mockNativeStreamEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: abortController.signal,
      }),
    );
  });
});

describe("fetchAttachment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApiMode("native");
  });

  it("uses native JSON-RPC for native mode with sender", async () => {
    mockNativeRpcRequest.mockResolvedValue({ data: "base64data" });

    const result = await fetchAttachment({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      attachmentId: "attachment-123",
      sender: "+15550001111",
    });

    expect(result).toBeInstanceOf(Buffer);
    expect(mockNativeRpcRequest).toHaveBeenCalledWith(
      "getAttachment",
      expect.objectContaining({
        id: "attachment-123",
        account: "+14259798283",
        recipient: "+15550001111",
      }),
      expect.anything(),
    );
  });

  it("uses container REST for container mode", async () => {
    setApiMode("container");
    const mockBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mockContainerFetchAttachment.mockResolvedValue(mockBuffer);

    const result = await fetchAttachment({
      baseUrl: "http://localhost:8080",
      attachmentId: "attachment-123",
    });

    expect(result).toBe(mockBuffer);
    expect(mockContainerFetchAttachment).toHaveBeenCalledWith(
      "attachment-123",
      expect.objectContaining({ baseUrl: "http://localhost:8080" }),
    );
  });

  it("returns null for native mode without sender or groupId", async () => {
    const result = await fetchAttachment({
      baseUrl: "http://localhost:8080",
      attachmentId: "attachment-123",
    });

    expect(result).toBeNull();
    expect(mockNativeRpcRequest).not.toHaveBeenCalled();
  });

  it("uses groupId when provided for native mode", async () => {
    mockNativeRpcRequest.mockResolvedValue({ data: "base64data" });

    await fetchAttachment({
      baseUrl: "http://localhost:8080",
      attachmentId: "attachment-123",
      groupId: "group-123",
    });

    expect(mockNativeRpcRequest).toHaveBeenCalledWith(
      "getAttachment",
      expect.objectContaining({ groupId: "group-123" }),
      expect.anything(),
    );
  });

  it("returns null when native RPC returns no data", async () => {
    mockNativeRpcRequest.mockResolvedValue({});

    const result = await fetchAttachment({
      baseUrl: "http://localhost:8080",
      attachmentId: "attachment-123",
      sender: "+15550001111",
    });

    expect(result).toBeNull();
  });

  it("prefers groupId over sender when both provided", async () => {
    mockNativeRpcRequest.mockResolvedValue({ data: "base64data" });

    await fetchAttachment({
      baseUrl: "http://localhost:8080",
      attachmentId: "attachment-123",
      sender: "+15550001111",
      groupId: "group-123",
    });

    const callParams = mockNativeRpcRequest.mock.calls[0][1];
    expect(callParams).toHaveProperty("groupId", "group-123");
    expect(callParams).not.toHaveProperty("recipient");
  });

  it("passes timeout to container fetch", async () => {
    setApiMode("container");
    mockContainerFetchAttachment.mockResolvedValue(Buffer.from([]));

    await fetchAttachment({
      baseUrl: "http://localhost:8080",
      attachmentId: "attachment-123",
      timeoutMs: 60000,
    });

    expect(mockContainerFetchAttachment).toHaveBeenCalledWith(
      "attachment-123",
      expect.objectContaining({
        timeoutMs: 60000,
      }),
    );
  });
});
