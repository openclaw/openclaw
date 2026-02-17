import { beforeEach, describe, expect, it, vi } from "vitest";
import { signalCheck, signalRpcRequest, streamSignalEvents } from "./client.js";

const resolveFetchMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/fetch.js", () => ({
  resolveFetch: () => resolveFetchMock(),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("signal client backend compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses jsonrpc health check when /api/v1/check is available", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    resolveFetchMock.mockReturnValue(fetchMock);

    const res = await signalCheck("http://signal-jsonrpc:8080", 1000);

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://signal-jsonrpc:8080/api/v1/check");
  });

  it("falls back to REST health checks when /api/v1/check is missing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ versions: ["v1", "v2"], version: "0.97" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(["+15551110000"]));
    resolveFetchMock.mockReturnValue(fetchMock);

    const res = await signalCheck("http://signal-rest:8080", 1000);

    expect(res.ok).toBe(true);
    expect(res.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("http://signal-rest:8080/v1/about");
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe("http://signal-rest:8080/v1/health");
    expect(String(fetchMock.mock.calls[3]?.[0])).toBe("http://signal-rest:8080/v1/accounts");
  });

  it("skips /v1/accounts during REST health checks when account is configured", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ versions: ["v1", "v2"], version: "0.97" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    resolveFetchMock.mockReturnValue(fetchMock);

    const res = await signalCheck("http://signal-rest-accounted:8080", 1000, {
      account: "+15551110000",
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe(
      "http://signal-rest-accounted:8080/v1/health",
    );
    expect(
      fetchMock.mock.calls.some(
        (call) => String(call[0]) === "http://signal-rest-accounted:8080/v1/accounts",
      ),
    ).toBe(false);
  });

  it("reports REST health as not ready when no accounts are registered", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ versions: ["v1", "v2"], version: "0.97" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse([]));
    resolveFetchMock.mockReturnValue(fetchMock);

    const res = await signalCheck("http://signal-rest-no-accounts:8080", 1000);

    expect(res.ok).toBe(false);
    expect(res.status).toBe(204);
    expect(res.error).toContain("no account is registered");
  });

  it("deduplicates concurrent REST account checks during health probes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ versions: ["v1", "v2"], version: "0.97" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(["+15551110000"]));
    resolveFetchMock.mockReturnValue(fetchMock);

    const [first, second] = await Promise.all([
      signalCheck("http://signal-rest-concurrent:8080", 1000),
      signalCheck("http://signal-rest-concurrent:8080", 1000),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const accountCalls = fetchMock.mock.calls.filter(
      (call) => String(call[0]) === "http://signal-rest-concurrent:8080/v1/accounts",
    );
    expect(accountCalls).toHaveLength(1);
  });

  it("returns REST about payload for version requests", async () => {
    const about = { versions: ["v1", "v2"], version: "0.97", mode: "normal" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse(about))
      .mockResolvedValueOnce(jsonResponse(about));
    resolveFetchMock.mockReturnValue(fetchMock);

    const result = await signalRpcRequest("version", undefined, {
      baseUrl: "http://signal-rest-version:8080",
    });

    expect(result).toEqual(about);
  });

  it("maps send RPC to /v2/send with inferred account from /v1/accounts", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ versions: ["v1", "v2"] }))
      .mockResolvedValueOnce(jsonResponse(["+15551110000"]))
      .mockResolvedValueOnce(jsonResponse({ timestamp: 1730000000000 }));
    resolveFetchMock.mockReturnValue(fetchMock);

    const result = await signalRpcRequest<{ timestamp?: number }>(
      "send",
      {
        message: "hello",
        recipient: ["+15552220000"],
      },
      {
        baseUrl: "http://signal-rest-send:8080",
      },
    );

    expect(result.timestamp).toBe(1730000000000);
    expect(String(fetchMock.mock.calls[3]?.[0])).toBe("http://signal-rest-send:8080/v2/send");
    const sendInit = fetchMock.mock.calls[3]?.[1] as { body?: string } | undefined;
    expect(sendInit?.body).toBeDefined();
    const body = JSON.parse(sendInit?.body ?? "{}") as Record<string, unknown>;
    expect(body["number"]).toBe("+15551110000");
    expect(body["recipients"]).toEqual(["+15552220000"]);
    expect(body["message"]).toBe("hello");
  });

  it("falls back to /v1/send when /v2/send is unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ versions: ["v1", "v2"] }))
      .mockResolvedValueOnce(jsonResponse(["+15553330000"]))
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ timestamp: 1730000000100 }));
    resolveFetchMock.mockReturnValue(fetchMock);

    const result = await signalRpcRequest<{ timestamp?: number }>(
      "send",
      {
        message: "hello",
        recipient: ["+15554440000"],
      },
      {
        baseUrl: "http://signal-rest-send-v1:8080",
      },
    );

    expect(result.timestamp).toBe(1730000000100);
    expect(String(fetchMock.mock.calls[3]?.[0])).toBe("http://signal-rest-send-v1:8080/v2/send");
    expect(String(fetchMock.mock.calls[4]?.[0])).toBe("http://signal-rest-send-v1:8080/v1/send");
  });

  it("streams REST receive payloads as receive events", async () => {
    const abortController = new AbortController();
    const received: Array<{ event?: string; data?: string }> = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ versions: ["v1", "v2"] }))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            envelope: {
              sourceNumber: "+15550001111",
              dataMessage: { message: "hello" },
            },
          },
        ]),
      );
    resolveFetchMock.mockReturnValue(fetchMock);

    await streamSignalEvents({
      baseUrl: "http://signal-rest-receive:8080",
      account: "+15559990000",
      abortSignal: abortController.signal,
      onEvent: (event) => {
        received.push(event);
        abortController.abort();
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.event).toBe("receive");
    const payload = JSON.parse(received[0]?.data ?? "{}") as Record<string, unknown>;
    expect(payload["envelope"]).toBeTruthy();
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain(
      "http://signal-rest-receive:8080/v1/receive/%2B15559990000?timeout=10",
    );
  });

  it("uses a longer default timeout for REST sends and returns a timeout-specific error", async () => {
    const abortError = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ versions: ["v1", "v2"] }))
      .mockResolvedValueOnce(jsonResponse(["+15551110000"]))
      .mockRejectedValueOnce(abortError);
    resolveFetchMock.mockReturnValue(fetchMock);

    await expect(
      signalRpcRequest(
        "send",
        {
          message: "hello",
          recipient: ["+15552220000"],
        },
        {
          baseUrl: "http://signal-rest-send-timeout:8080",
        },
      ),
    ).rejects.toThrow("Signal REST send timed out after 90000ms (/v2/send)");
  });

  it("respects explicit timeout overrides for REST send timeout errors", async () => {
    const abortError = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ versions: ["v1", "v2"] }))
      .mockResolvedValueOnce(jsonResponse(["+15551110000"]))
      .mockRejectedValueOnce(abortError);
    resolveFetchMock.mockReturnValue(fetchMock);

    await expect(
      signalRpcRequest(
        "send",
        {
          message: "hello",
          recipient: ["+15552220000"],
        },
        {
          baseUrl: "http://signal-rest-send-timeout-override:8080",
          timeoutMs: 45_000,
        },
      ),
    ).rejects.toThrow("Signal REST send timed out after 45000ms (/v2/send)");
  });
});
