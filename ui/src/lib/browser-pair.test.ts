// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canPairBrowserWithGateway, createBrowserPairSession } from "./browser-pair.ts";

vi.mock("./nodes/index.ts", () => ({
  loadOrCreateDeviceIdentity: vi.fn(async () => ({
    deviceId: "0123456789abcdef",
    publicKey: "public",
    privateKey: "private",
  })),
  signDevicePayload: vi.fn(async () => "signature"),
}));

const started = { requestId: "request-1", code: "ABCDEFGH", expiresAtMs: Date.now() + 600_000 };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function session() {
  const onState = vi.fn();
  const onApproved = vi.fn();
  return {
    onState,
    onApproved,
    ...createBrowserPairSession({ basePath: "", onState, onApproved }),
  };
}

describe("browser pair session", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps waiting through failed polls, then hands over the approval", async () => {
    const replies = [
      json(started),
      json({ status: "pending" }),
      json({ error: "rate_limited" }, 429),
      json({ status: "approved", bootstrapToken: "bootstrap" }),
    ];
    const fetchMock = vi.fn(async () => replies.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    const pair = session();
    await pair.start();
    expect(pair.onState).toHaveBeenLastCalledWith({
      kind: "waiting",
      code: "ABCD-EFGH",
      browserId: "01234567",
    });
    await vi.advanceTimersByTimeAsync(4_100);
    expect(pair.onApproved).toHaveBeenCalledWith("bootstrap");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    [{ status: "rejected" }, 200, "declined"],
    [{ status: "expired" }, 200, "expired"],
    [{ error: "not_found" }, 404, "expired"],
  ])("stops on a final answer %j", async (body, status, reason) => {
    const replies = [json(started), json(body, status)];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => replies.shift()!),
    );
    const pair = session();
    await pair.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(pair.onState).toHaveBeenLastCalledWith({ kind: "failed", reason });
  });

  it("stops polling once cancelled", async () => {
    const fetchMock = vi.fn(async () =>
      fetchMock.mock.calls.length === 1 ? json(started) : json({ status: "pending" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const pair = session();
    await pair.start();
    await vi.advanceTimersByTimeAsync(10);
    pair.cancel();
    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(pair.onState).toHaveBeenLastCalledWith({ kind: "idle" });
  });

  it("names a full Gateway separately from a broken one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "capacity" }, 429)),
    );
    const pair = session();
    await pair.start();
    expect(pair.onState).toHaveBeenLastCalledWith({ kind: "failed", reason: "busy" });
  });

  it("offers pairing only for the Gateway serving this page", () => {
    expect(canPairBrowserWithGateway(`ws://${window.location.host}`)).toBe(true);
    expect(canPairBrowserWithGateway("wss://other.example")).toBe(false);
    expect(canPairBrowserWithGateway("")).toBe(false);
  });
});
