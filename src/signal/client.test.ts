import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithTimeoutMock = vi.fn();
const fetchImpl = vi.fn();

vi.mock("../infra/fetch.js", () => ({
  resolveFetch: () => fetchImpl,
}));

vi.mock("../utils/fetch-timeout.js", () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeoutMock(...args),
}));

function makeResponse(params: {
  status?: number;
  ok?: boolean;
  statusText?: string;
  text: string;
}) {
  return {
    status: params.status ?? 200,
    ok: params.ok ?? true,
    statusText: params.statusText ?? "OK",
    text: async () => params.text,
  };
}

describe("signal client typed errors and retry", () => {
  beforeEach(() => {
    fetchWithTimeoutMock.mockReset();
    fetchImpl.mockReset();
  });

  it("throws SignalRpcError for JSON-RPC errors", async () => {
    const { signalRpcRequest, SignalRpcError } = await import("./client.js");
    fetchWithTimeoutMock.mockResolvedValueOnce(
      makeResponse({
        text: JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "boom" },
        }),
      }),
    );

    await expect(
      signalRpcRequest("send", { recipient: ["+15550001111"] }, { baseUrl: "http://signal.local" }),
    ).rejects.toBeInstanceOf(SignalRpcError);
  });

  it("throws SignalHttpError for non-2xx responses", async () => {
    const { signalRpcRequest, SignalHttpError } = await import("./client.js");
    fetchWithTimeoutMock.mockResolvedValueOnce(
      makeResponse({
        status: 503,
        ok: false,
        statusText: "Service Unavailable",
        text: "unavailable",
      }),
    );

    await expect(
      signalRpcRequest("send", { recipient: ["+15550001111"] }, { baseUrl: "http://signal.local" }),
    ).rejects.toBeInstanceOf(SignalHttpError);
  });

  it("throws SignalNetworkError for malformed RPC envelopes", async () => {
    const { signalRpcRequest, SignalNetworkError } = await import("./client.js");
    fetchWithTimeoutMock.mockResolvedValueOnce(
      makeResponse({
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
        }),
      }),
    );

    await expect(
      signalRpcRequest("send", { recipient: ["+15550001111"] }, { baseUrl: "http://signal.local" }),
    ).rejects.toBeInstanceOf(SignalNetworkError);
  });

  it("retries recoverable timeouts with backoff", async () => {
    const { signalRpcRequestWithRetry } = await import("./client.js");
    fetchWithTimeoutMock.mockRejectedValueOnce(new Error("request timeout")).mockResolvedValueOnce(
      makeResponse({
        text: JSON.stringify({
          jsonrpc: "2.0",
          result: { timestamp: 1700000000001 },
        }),
      }),
    );

    const result = await signalRpcRequestWithRetry<{ timestamp: number }>(
      "send",
      { recipient: ["+15550001111"], message: "hi" },
      {
        baseUrl: "http://signal.local",
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      },
    );

    expect(result.timestamp).toBe(1700000000001);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });
});
