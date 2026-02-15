import { afterEach, describe, expect, it, vi } from "vitest";
import { probeMessengerPage } from "./probe.js";

describe("probeMessengerPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns success with page info", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ name: "Test Page", id: "123456" }),
      }),
    );

    const result = await probeMessengerPage("valid-token", 5000);

    expect(result.ok).toBe(true);
    expect(result.page?.name).toBe("Test Page");
    expect(result.page?.id).toBe("123456");
  });

  it("returns failure when API returns error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "Invalid token",
      }),
    );

    const result = await probeMessengerPage("bad-token", 5000);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("401");
  });

  it("returns failure for empty token", async () => {
    const result = await probeMessengerPage("", 5000);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not configured");
  });

  it("returns timeout when fetch stalls", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener("abort", () => reject(new DOMException("aborted")));
          }),
      ),
    );

    const probePromise = probeMessengerPage("valid-token", 10);
    await vi.advanceTimersByTimeAsync(20);
    const result = await probePromise;

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
