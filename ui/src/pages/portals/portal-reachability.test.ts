/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { probePortalReachable } from "./portal-reachability.ts";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("probePortalReachable", () => {
  it("accepts any settled no-cors response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ type: "opaque" });
    vi.stubGlobal("fetch", fetchMock);
    await expect(probePortalReachable("https://gateway.example.test:43123/app")).resolves.toBe(
      "reachable",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example.test:43123/app",
      expect.objectContaining({ mode: "no-cors", signal: expect.any(AbortSignal) }),
    );
  });
  it("reports unreachable when the reachability deadline aborts the request", async () => {
    const controller = new AbortController();
    const timeoutMock = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const { promise, reject } = Promise.withResolvers<never>();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        return promise;
      }),
    );
    const result = probePortalReachable("https://gateway.example.test:43123/app");
    controller.abort(new DOMException("Timed out", "TimeoutError"));
    await expect(result).resolves.toBe("unreachable");
    expect(timeoutMock).toHaveBeenCalledWith(4_000);
  });
  // Probe CSP is not frame-src; unrelated violations must not mask unreachable Portals.
  it.each([
    ["http://127.0.0.1:42065", "blocked"],
    ["inline", "unreachable"],
  ] as const)("classifies a policy violation for %s as %s", async (blockedURI, expected) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        document.dispatchEvent(Object.assign(new Event("securitypolicyviolation"), { blockedURI }));
        return Promise.reject(new TypeError("Failed to fetch"));
      }),
    );
    await expect(probePortalReachable("http://127.0.0.1:42065/?openclaw_portal=abc")).resolves.toBe(
      expected,
    );
  });
});
