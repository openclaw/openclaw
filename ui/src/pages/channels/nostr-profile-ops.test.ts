import { afterEach, describe, expect, it, vi } from "vitest";
import type { NostrProfile } from "../../api/types.ts";
import { importNostrProfile, putNostrProfile } from "./nostr-profile-ops.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const dummyProfile = {
  name: "Test Profile",
  about: "About text",
  picture: "https://example.com/picture.png",
  nip05: "test@example.com",
} as unknown as NostrProfile;

describe("putNostrProfile", () => {
  it("publishes a profile and returns parsed data", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ ok: true, persisted: true }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await putNostrProfile({
      accountId: "abc123",
      headers: { "x-custom": "1" },
      values: dummyProfile,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/channels/nostr/abc123/profile",
      expect.objectContaining({
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-custom": "1" },
        body: JSON.stringify(dummyProfile),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result.response.ok).toBe(true);
    expect(result.data).toEqual({ ok: true, persisted: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a stalled publish after the request deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("missing nostr publish signal");
      }
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            reject(signal.reason as Error);
          },
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = putNostrProfile({
      accountId: "abc123",
      headers: {},
      values: dummyProfile,
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/channels/nostr/abc123/profile");
    expect(init?.signal?.aborted).toBe(false);

    const outcome = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(init?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await outcome;
    expect(init?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("importNostrProfile", () => {
  it("imports a profile and returns parsed data", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const imported = { name: "Imported" };
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ ok: true, imported, saved: true }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await importNostrProfile({
      accountId: "def456",
      headers: { "x-custom": "2" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/channels/nostr/def456/profile/import",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json", "x-custom": "2" },
        body: JSON.stringify({ autoMerge: true }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result.response.ok).toBe(true);
    expect(result.data).toEqual({ ok: true, imported, saved: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a stalled import after the request deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("missing nostr import signal");
      }
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            reject(signal.reason as Error);
          },
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = importNostrProfile({ accountId: "def456", headers: {} });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/channels/nostr/def456/profile/import");
    expect(init?.signal?.aborted).toBe(false);

    const outcome = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(init?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await outcome;
    expect(init?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
