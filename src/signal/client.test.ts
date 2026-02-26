import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithTimeoutMock = vi.fn();
const resolveFetchMock = vi.fn();

vi.mock("../infra/fetch.js", () => ({
  resolveFetch: (...args: unknown[]) => resolveFetchMock(...args),
}));

vi.mock("../infra/secure-random.js", () => ({
  generateSecureUuid: () => "test-id",
}));

vi.mock("../utils/fetch-timeout.js", () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeoutMock(...args),
}));

import { signalRpcRequest, streamSignalEvents } from "./client.js";

function rpcResponse(body: unknown, status = 200): Response {
  if (typeof body === "string") {
    return new Response(body, { status });
  }
  return new Response(JSON.stringify(body), { status });
}

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("signalRpcRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveFetchMock.mockReturnValue(vi.fn());
  });

  it("returns parsed RPC result", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      rpcResponse({ jsonrpc: "2.0", result: { version: "0.13.22" }, id: "test-id" }),
    );

    const result = await signalRpcRequest<{ version: string }>("version", undefined, {
      baseUrl: "http://127.0.0.1:8080",
    });

    expect(result).toEqual({ version: "0.13.22" });
  });

  it("throws a wrapped error when RPC response JSON is malformed", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(rpcResponse("not-json", 502));

    await expect(
      signalRpcRequest("version", undefined, {
        baseUrl: "http://127.0.0.1:8080",
      }),
    ).rejects.toMatchObject({
      message: "Signal RPC returned malformed JSON (status 502)",
      cause: expect.any(SyntaxError),
    });
  });

  it("throws when RPC response envelope has neither result nor error", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(rpcResponse({ jsonrpc: "2.0", id: "test-id" }));

    await expect(
      signalRpcRequest("version", undefined, {
        baseUrl: "http://127.0.0.1:8080",
      }),
    ).rejects.toThrow("Signal RPC returned invalid response envelope (status 200)");
  });
});

describe("streamSignalEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to username query when account query is rejected", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 400 }))
      .mockResolvedValueOnce(sseResponse(["event: message\ndata: hello\n\n"]));
    resolveFetchMock.mockReturnValue(fetchImpl);
    const onEvent = vi.fn();

    await streamSignalEvents({
      baseUrl: "http://127.0.0.1:8080",
      account: "+15550001111",
      onEvent,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstUrl = fetchImpl.mock.calls[0]?.[0] as URL;
    const secondUrl = fetchImpl.mock.calls[1]?.[0] as URL;
    expect(firstUrl.searchParams.get("account")).toBe("+15550001111");
    expect(firstUrl.searchParams.get("username")).toBeNull();
    expect(secondUrl.searchParams.get("account")).toBeNull();
    expect(secondUrl.searchParams.get("username")).toBe("+15550001111");
    expect(onEvent).toHaveBeenCalledWith({ event: "message", data: "hello", id: undefined });
  });

  it("keeps account query when the server accepts it", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(sseResponse(["data: ok\n\n"]));
    resolveFetchMock.mockReturnValue(fetchImpl);

    await streamSignalEvents({
      baseUrl: "http://127.0.0.1:8080",
      account: "+15550001111",
      onEvent: vi.fn(),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const firstUrl = fetchImpl.mock.calls[0]?.[0] as URL;
    expect(firstUrl.searchParams.get("account")).toBe("+15550001111");
    expect(firstUrl.searchParams.get("username")).toBeNull();
  });
});
