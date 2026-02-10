import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock resolveFetch so we can control HTTP responses
const mockFetch = vi.fn();
vi.mock("../infra/fetch.js", () => ({
  resolveFetch: () => mockFetch,
}));

import { signalCheck } from "./client.js";

describe("signalCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok when REST /api/v1/check succeeds", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

    const result = await signalCheck("http://127.0.0.1:8080", 1000);

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    // Should only call REST endpoint, not JSON-RPC
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain("/api/v1/check");
  });

  it("falls back to JSON-RPC when REST /api/v1/check returns non-ok", async () => {
    // REST endpoint returns 404 (signal-cli 0.13+)
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    // JSON-RPC version call succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jsonrpc: "2.0", result: { version: "0.13.23" }, id: "1" }),
    });

    const result = await signalCheck("http://127.0.0.1:8080", 1000);

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toContain("/api/v1/check");
    expect(mockFetch.mock.calls[1][0]).toContain("/api/v1/rpc");
  });

  it("falls back to JSON-RPC when REST /api/v1/check throws", async () => {
    // REST endpoint throws (connection refused, etc.)
    mockFetch.mockRejectedValueOnce(new Error("fetch failed"));
    // JSON-RPC version call succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jsonrpc: "2.0", result: { version: "0.13.23" }, id: "1" }),
    });

    const result = await signalCheck("http://127.0.0.1:8080", 1000);

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT fall back to JSON-RPC on non-404 HTTP errors (e.g. 500, 401)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await signalCheck("http://127.0.0.1:8080", 1000);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toBe("HTTP 500");
    // Should NOT attempt JSON-RPC fallback
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT fall back to JSON-RPC on 401 Unauthorized", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const result = await signalCheck("http://127.0.0.1:8080", 1000);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns error when both REST (404) and JSON-RPC fail", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    mockFetch.mockRejectedValueOnce(new Error("connection refused"));

    const result = await signalCheck("http://127.0.0.1:8080", 1000);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("connection refused");
  });

  it("returns error when both REST throws and JSON-RPC fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));
    mockFetch.mockRejectedValueOnce(new Error("rpc unavailable"));

    const result = await signalCheck("http://127.0.0.1:8080", 1000);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("rpc unavailable");
  });
});
