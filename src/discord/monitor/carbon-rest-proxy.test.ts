import { describe, expect, it, vi, afterEach } from "vitest";
import { patchCarbonRestProxy } from "./carbon-rest-proxy.js";

const { proxyAgentSpy } = vi.hoisted(() => ({
  proxyAgentSpy: vi.fn(),
}));

vi.mock("undici", () => {
  class ProxyAgent {
    proxyUrl: string;
    constructor(proxyUrl: string) {
      if (proxyUrl === "bad-proxy") {
        throw new Error("bad proxy");
      }
      this.proxyUrl = proxyUrl;
      proxyAgentSpy(proxyUrl);
    }
  }

  const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") });

  return { ProxyAgent, fetch: mockFetch };
});

function makeRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as const;
}

describe("patchCarbonRestProxy", () => {
  const savedFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  it("is a no-op when proxy URL is empty", () => {
    const executeRequest = vi.fn();
    const client = { rest: { executeRequest } };
    const runtime = makeRuntime();

    patchCarbonRestProxy(client, "   ", runtime);

    expect(client.rest.executeRequest).toBe(executeRequest);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("is a no-op when proxy URL is undefined", () => {
    const executeRequest = vi.fn();
    const client = { rest: { executeRequest } };
    const runtime = makeRuntime();

    patchCarbonRestProxy(client, undefined, runtime);

    expect(client.rest.executeRequest).toBe(executeRequest);
  });

  it("wraps executeRequest to temporarily swap globalThis.fetch", async () => {
    const originalFetch = vi.fn();
    globalThis.fetch = originalFetch;

    let capturedFetch: typeof fetch | undefined;
    const fakeExecuteRequest = vi.fn().mockImplementation(async () => {
      // Inside executeRequest, globalThis.fetch should be the proxy version
      capturedFetch = globalThis.fetch;
      return { ok: true };
    });

    const client = { rest: { executeRequest: fakeExecuteRequest } };
    const runtime = makeRuntime();
    proxyAgentSpy.mockClear();

    patchCarbonRestProxy(client, "http://proxy.test:8080", runtime);

    expect(proxyAgentSpy).toHaveBeenCalledWith("http://proxy.test:8080");
    expect(runtime.log).toHaveBeenCalledWith("discord: carbon rest proxy enabled");

    // Call the patched executeRequest
    const request = { method: "GET", path: "/test", routeKey: "GET:/test" };
    await client.rest.executeRequest(request);

    // During execution, fetch should have been swapped
    expect(capturedFetch).toBeDefined();
    expect(capturedFetch).not.toBe(originalFetch);

    // After execution, fetch should be restored
    expect(globalThis.fetch).toBe(originalFetch);

    // The original executeRequest should have been called with the request
    expect(fakeExecuteRequest).toHaveBeenCalledWith(request);
  });

  it("restores globalThis.fetch even when executeRequest throws", async () => {
    const originalFetch = vi.fn();
    globalThis.fetch = originalFetch;

    const fakeExecuteRequest = vi.fn().mockRejectedValue(new Error("boom"));
    const client = { rest: { executeRequest: fakeExecuteRequest } };
    const runtime = makeRuntime();

    patchCarbonRestProxy(client, "http://proxy.test:8080", runtime);

    await expect(client.rest.executeRequest({ method: "GET" })).rejects.toThrow("boom");

    // fetch must be restored
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("does not double-patch", () => {
    const executeRequest = vi.fn();
    const client = { rest: { executeRequest } };
    const runtime = makeRuntime();

    patchCarbonRestProxy(client, "http://proxy.test:8080", runtime);
    const firstPatch = client.rest.executeRequest;

    patchCarbonRestProxy(client, "http://proxy.test:9090", runtime);
    expect(client.rest.executeRequest).toBe(firstPatch);
  });

  it("logs error and leaves executeRequest untouched for invalid proxy", () => {
    const executeRequest = vi.fn();
    const client = { rest: { executeRequest } };
    const runtime = makeRuntime();

    patchCarbonRestProxy(client, "bad-proxy", runtime);

    expect(client.rest.executeRequest).toBe(executeRequest);
    expect(runtime.error).toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });
});
