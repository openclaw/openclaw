import { describe, it, expect, vi, beforeEach } from "vitest";
import { putNostrProfile, importNostrProfile } from "./nostr-profile-ops.ts";

function mockFetch() {
  globalThis.fetch = vi.fn().mockResolvedValue({ json: () => Promise.resolve({}) });
}

describe("putNostrProfile", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  it("passes AbortSignal.timeout(15000)", async () => {
    const signal = new AbortController().signal;
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    mockFetch();
    await putNostrProfile({ accountId: "t", headers: {}, values: {} as any });
    expect((globalThis.fetch as any).mock.calls[0][1].signal).toBe(signal);
  });
  it("rejects on timeout", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    globalThis.fetch = vi.fn().mockImplementation(
      (_u: string, init: RequestInit) =>
        new Promise((_, reject) => {
          const s = init.signal as AbortSignal;
          if (s.aborted) {
            reject(s.reason);
          } else {
            s.addEventListener("abort", () => reject(s.reason), { once: true });
          }
        }),
    );
    const p = putNostrProfile({ accountId: "t", headers: {}, values: {} as any });
    controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    await expect(p).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("importNostrProfile", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  it("passes AbortSignal.timeout(15000)", async () => {
    const signal = new AbortController().signal;
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    mockFetch();
    await importNostrProfile({ accountId: "t", headers: {} });
    expect((globalThis.fetch as any).mock.calls[0][1].signal).toBe(signal);
  });
  it("rejects on timeout", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    globalThis.fetch = vi.fn().mockImplementation(
      (_u: string, init: RequestInit) =>
        new Promise((_, reject) => {
          const s = init.signal as AbortSignal;
          if (s.aborted) {
            reject(s.reason);
          } else {
            s.addEventListener("abort", () => reject(s.reason), { once: true });
          }
        }),
    );
    const p = importNostrProfile({ accountId: "t", headers: {} });
    controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    await expect(p).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
