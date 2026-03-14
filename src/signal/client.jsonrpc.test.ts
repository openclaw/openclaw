import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectSignalApiMode, pollSignalJsonRpc, type SignalSseEvent } from "./client.js";

// ---------- detectSignalApiMode tests (mock fetch) ----------

const fetchMock = vi.fn();
vi.mock("../infra/fetch.js", () => ({
  resolveFetch: () => fetchMock,
}));

vi.mock("../utils/fetch-timeout.js", () => ({
  fetchWithTimeout: (url: string, init: RequestInit, _timeout: number, fetchImpl: typeof fetch) =>
    fetchImpl(url, init),
}));

describe("detectSignalApiMode", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('returns "sse" when /api/v1/events responds 200', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: { cancel: vi.fn() },
    });
    const mode = await detectSignalApiMode("http://localhost:8080");
    expect(mode).toBe("sse");
  });

  it('returns "jsonrpc" when /api/v1/events responds 404', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      body: null,
    });
    const mode = await detectSignalApiMode("http://localhost:8080");
    expect(mode).toBe("jsonrpc");
  });

  it('returns "jsonrpc" when fetch throws (connection refused)', async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const mode = await detectSignalApiMode("http://localhost:8080");
    expect(mode).toBe("jsonrpc");
  });
});

// ---------- pollSignalJsonRpc tests (mock fetch) ----------

describe("pollSignalJsonRpc", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("converts receive results into SignalSseEvents", async () => {
    const events: SignalSseEvent[] = [];
    const envelope = {
      sourceNumber: "+15550001111",
      dataMessage: { message: "hello" },
    };

    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            jsonrpc: "2.0",
            result: [{ envelope }],
            id: "1",
          }),
        ),
    });

    await pollSignalJsonRpc({
      baseUrl: "http://localhost:8080",
      onEvent: (event) => events.push(event),
      pollTimeoutSec: 1,
    });

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("receive");
    const data = JSON.parse(events[0].data!);
    expect(data.envelope.sourceNumber).toBe("+15550001111");
    expect(data.envelope.dataMessage.message).toBe("hello");
  });

  it("emits nothing when receive returns empty array", async () => {
    const events: SignalSseEvent[] = [];

    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ jsonrpc: "2.0", result: [], id: "1" })),
    });

    await pollSignalJsonRpc({
      baseUrl: "http://localhost:8080",
      onEvent: (event) => events.push(event),
      pollTimeoutSec: 1,
    });

    expect(events).toHaveLength(0);
  });

  it("emits multiple events for batch results", async () => {
    const events: SignalSseEvent[] = [];

    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            jsonrpc: "2.0",
            result: [
              { envelope: { sourceNumber: "+1111" } },
              { envelope: { sourceNumber: "+2222" } },
            ],
            id: "1",
          }),
        ),
    });

    await pollSignalJsonRpc({
      baseUrl: "http://localhost:8080",
      onEvent: (event) => events.push(event),
      pollTimeoutSec: 1,
    });

    expect(events).toHaveLength(2);
  });

  it("returns immediately when abortSignal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      pollSignalJsonRpc({
        baseUrl: "http://localhost:8080",
        abortSignal: controller.signal,
        onEvent: () => {},
      }),
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes account parameter to RPC request", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ jsonrpc: "2.0", result: [], id: "1" })),
    });

    await pollSignalJsonRpc({
      baseUrl: "http://localhost:8080",
      account: "+15551234567",
      onEvent: () => {},
      pollTimeoutSec: 1,
    });

    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(callBody.params.account).toBe("+15551234567");
    expect(callBody.params.timeout).toBe(1);
  });
});
