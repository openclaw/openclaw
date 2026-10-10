import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelCapability } from "./index.ts";
import { initialWeixinQrState } from "./weixin-qr-state.ts";
import { createWeixinQrController, isWeixinQrImage } from "./weixin-qr.ts";

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jcxkAAAAASUVORK5CYII=";
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let state = initialWeixinQrState();
  const request = vi.fn();
  const preflight = vi.fn().mockResolvedValue({ ok: true, supportsPageLogin: true });
  const started = pending<void>();
  const client = {
    request: vi.fn().mockImplementation((method, params) => {
      if (method === "weixin.login.control" && params?.action === "capabilities") {
        return preflight(method, params);
      }
      if (method === "web.login.start") {
        started.resolve();
      }
      return request(method, params);
    }),
  };
  let current: typeof client | null = client;
  const refresh = vi.fn(async () => {});
  const owner = createWeixinQrController({
    getClient: () => current,
    setState: (next) => {
      state = next;
    },
    refresh,
  });
  return {
    owner,
    request,
    preflight,
    started: started.promise,
    refresh,
    get state() {
      return state;
    },
    disconnect() {
      current = null;
      owner.invalidate();
    },
  };
}
const startResult = () => ({
  qrDataUrl: png,
  sessionKey: "session-a",
  expiresAtMs: Date.now() + 60_000,
});

describe("Weixin page login", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("cancels a Channels login whose QR start response arrives after close", async () => {
    const delayed = pending<ReturnType<typeof startResult>>();
    const started = pending<void>();
    const request = vi.fn().mockImplementation((method) => {
      if (method === "web.login.start") {
        started.resolve();
        return delayed.promise;
      }
      return Promise.resolve({ ok: true, supportsPageLogin: true });
    });
    const capability = createChannelCapability({
      snapshot: {
        client: { request },
        phase: "connected",
        hello: { auth: { role: "operator", scopes: ["operator.admin"] } },
      },
      subscribe: () => () => {},
      subscribeEvents: () => () => {},
    });
    const start = capability.startWeixin(createWeixinQrController);
    await started.promise;
    await capability.closeWeixin();
    delayed.resolve(startResult());
    await start;
    expect(request).toHaveBeenLastCalledWith("weixin.login.control", {
      action: "cancel",
      sessionKey: "session-a",
    });
    expect(capability.state.weixinLogin).toEqual(initialWeixinQrState());
    capability.dispose();
  });
  it("does not request core QR takeover when the installed plugin lacks page support", async () => {
    const f = fixture();
    f.preflight.mockRejectedValueOnce(new Error("Unknown method: weixin.login.control"));
    await f.owner.start();
    expect(f.state.phase).toBe("error");
    expect(f.state.message).toContain("Update the plugin");
    expect(f.request).not.toHaveBeenCalled();
    f.owner.invalidate();
  });
  it("shows the plugin capability reason without requesting core QR takeover", async () => {
    const f = fixture();
    f.preflight.mockResolvedValueOnce({
      ok: true,
      supportsPageLogin: false,
      message: "Update OpenClaw to use page login safely.",
    });
    await f.owner.start();
    expect(f.state.phase).toBe("error");
    expect(f.state.message).toBe("Update OpenClaw to use page login safely.");
    expect(f.request).not.toHaveBeenCalled();
    f.owner.invalidate();
  });
  it("does not start login after a capability probe is closed", async () => {
    const f = fixture();
    const probe = pending<{ supportsPageLogin: boolean }>();
    f.preflight.mockReturnValueOnce(probe.promise);
    const start = f.owner.start();
    await f.owner.close();
    probe.resolve({ supportsPageLogin: true });
    await start;
    expect(f.request).not.toHaveBeenCalled();
    expect(f.state).toEqual(initialWeixinQrState());
  });
  it("rejects URLs, raw contents, malformed and unbounded image data", () => {
    expect(isWeixinQrImage(png)).toBe(true);
    for (const value of [
      "https://example.test/qr",
      "raw-qr",
      "data:image/svg+xml,<svg/>",
      "data:image/png;base64,AAAA",
      "data:image/png;base64,iVBORw0KGgo" + "A".repeat(256_000),
    ]) {
      expect(isWeixinQrImage(value)).toBe(false);
    }
  });
  it("routes start and automatic polling to Weixin with the exact session, then refreshes canonical status", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce(startResult()).mockResolvedValueOnce({ connected: true });
    await f.owner.start();
    expect(f.state.phase).toBe("waiting");
    expect(f.request).toHaveBeenNthCalledWith(1, "web.login.start", {
      channel: "openclaw-weixin",
      force: false,
      preserveRunning: true,
      timeoutMs: 30_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.request).toHaveBeenNthCalledWith(2, "web.login.wait", {
      channel: "openclaw-weixin",
      sessionKey: "session-a",
      preserveRunning: true,
      timeoutMs: 10_000,
    });
    expect(f.state.qrDataUrl).toBeNull();
    expect(f.state.sessionKey).toBeNull();
    expect(f.refresh).toHaveBeenCalledOnce();
    f.owner.invalidate();
  });
  it("closes an in-flight wait remotely and ignores its later connected result", async () => {
    const f = fixture();
    const wait = pending<{ connected: boolean }>();
    f.request
      .mockResolvedValueOnce(startResult())
      .mockReturnValueOnce(wait.promise)
      .mockResolvedValueOnce({ ok: true });
    await f.owner.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await f.owner.close();
    wait.resolve({ connected: true });
    await Promise.resolve();
    expect(f.request).toHaveBeenLastCalledWith("weixin.login.control", {
      action: "cancel",
      sessionKey: "session-a",
    });
    expect(f.state).toEqual(initialWeixinQrState());
    expect(f.refresh).not.toHaveBeenCalled();
  });
  it("cancels a start response that arrives after navigation", async () => {
    const f = fixture();
    const start = pending<ReturnType<typeof startResult>>();
    f.request.mockReturnValueOnce(start.promise).mockResolvedValue({ ok: true });
    const run = f.owner.start();
    await f.started;
    await f.owner.close();
    start.resolve(startResult());
    await run;
    expect(f.state.phase).toBe("idle");
    expect(f.request).toHaveBeenLastCalledWith("weixin.login.control", {
      action: "cancel",
      sessionKey: "session-a",
    });
  });
  it("scrubs a QR at expiry even while a wait request is pending", async () => {
    const f = fixture();
    f.request
      .mockResolvedValueOnce({ ...startResult(), expiresAtMs: Date.now() + 2_000 })
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue({ ok: true });
    await f.owner.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.state.qrDataUrl).toBeNull();
    expect(f.state.phase).toBe("expired");
    f.owner.invalidate();
  });
  it("publishes refreshed QR and resumes polling after verification without retaining the code", async () => {
    const f = fixture();
    f.request
      .mockResolvedValueOnce(startResult())
      .mockResolvedValueOnce({ ...startResult(), verificationRequired: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ...startResult(), expiresAtMs: Date.now() + 120_000 });
    await f.owner.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.state.phase).toBe("verification");
    await f.owner.verify(" 123456 ");
    expect(f.request).toHaveBeenLastCalledWith("weixin.login.control", {
      action: "verify",
      sessionKey: "session-a",
      code: "123456",
    });
    expect(JSON.stringify(f.state)).not.toContain("123456");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.state.phase).toBe("waiting");
    expect(f.state.expiresAtMs).toBeGreaterThan(Date.now() + 60_000);
    f.owner.invalidate();
  });
  it("retains the current unexpired QR for a verification-only wait response", async () => {
    const f = fixture();
    const initial = startResult();
    f.request
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({ verificationRequired: true, message: "Enter the code" })
      .mockResolvedValueOnce({ ok: true });
    await f.owner.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.state).toMatchObject({
      phase: "verification",
      sessionKey: initial.sessionKey,
      qrDataUrl: initial.qrDataUrl,
      expiresAtMs: initial.expiresAtMs,
    });
    await f.owner.verify("123456");
    expect(f.request).toHaveBeenLastCalledWith("weixin.login.control", {
      action: "verify",
      sessionKey: "session-a",
      code: "123456",
    });
    f.owner.invalidate();
  });
  it("does not revive an expired QR from a verification-only wait response", async () => {
    const f = fixture();
    const wait = pending<{ verificationRequired: boolean }>();
    f.request
      .mockResolvedValueOnce({ ...startResult(), expiresAtMs: Date.now() + 2_000 })
      .mockReturnValueOnce(wait.promise)
      .mockResolvedValue({ ok: true });
    await f.owner.start();
    await vi.advanceTimersByTimeAsync(2_000);
    wait.resolve({ verificationRequired: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.state.phase).toBe("error");
    expect(f.state.qrDataUrl).toBeNull();
    expect(f.state.sessionKey).toBeNull();
    f.owner.invalidate();
  });
  it("expires a verification form and does not submit an invalid or expired code", async () => {
    const f = fixture();
    f.request
      .mockResolvedValueOnce({
        ...startResult(),
        verificationRequired: true,
        expiresAtMs: Date.now() + 2_000,
      })
      .mockResolvedValue({ ok: true });
    await f.owner.start();
    await f.owner.verify("not-digits");
    expect(f.state.phase).toBe("verification");
    expect(f.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.state.phase).toBe("expired");
    expect(f.state.qrDataUrl).toBeNull();
    await f.owner.verify("123456");
    expect(f.request).toHaveBeenCalledTimes(1);
    f.owner.invalidate();
  });
  it("surfaces unsupported plugin output and failed cancellation", async () => {
    const f = fixture();
    f.request
      .mockResolvedValueOnce({ ...startResult(), qrDataUrl: "https://example.test/qr" })
      .mockResolvedValueOnce({ ok: true });
    await f.owner.start();
    expect(f.state.phase).toBe("error");
    expect(f.state.qrDataUrl).toBeNull();
    f.request
      .mockResolvedValueOnce(startResult())
      .mockRejectedValueOnce(new Error("Cancellation failed"));
    await f.owner.start();
    await f.owner.close();
    expect(f.state.message).toContain("Cancellation failed");
    f.owner.invalidate();
  });
  it("keeps the provider's terminal failure visible and stops polling its removed session", async () => {
    const f = fixture();
    f.request
      .mockResolvedValueOnce(startResult())
      .mockResolvedValueOnce({
        connected: false,
        alreadyConnected: true,
        message: "No saved credentials",
      })
      .mockResolvedValue({ ok: true });
    await f.owner.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.state.phase).toBe("error");
    expect(f.state.message).toContain("No saved credentials");
    expect(f.state.qrDataUrl).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.request.mock.calls.filter(([method]) => method === "web.login.wait")).toHaveLength(1);
    f.owner.invalidate();
  });
  it("shows a failed start's provider reason and cancels its returned session", async () => {
    const f = fixture();
    f.request
      .mockResolvedValueOnce({ sessionKey: "failed", message: "Cannot fetch Weixin QR" })
      .mockResolvedValue({ ok: true });
    await f.owner.start();
    expect(f.state.message).toContain("Cannot fetch Weixin QR");
    expect(f.request).toHaveBeenLastCalledWith("weixin.login.control", {
      action: "cancel",
      sessionKey: "failed",
    });
    f.owner.invalidate();
  });
  it("invalidates Channels-owned login when admin authority changes on the same socket", async () => {
    const request = vi
      .fn()
      .mockImplementation((method) =>
        Promise.resolve(
          method === "web.login.start" ? startResult() : { ok: true, supportsPageLogin: true },
        ),
      );
    let snapshot = {
      client: { request },
      phase: "connected" as const,
      hello: { auth: { role: "operator", scopes: ["operator.admin"] } },
    };
    let listener!: (next: typeof snapshot) => void;
    const capability = createChannelCapability({
      get snapshot() {
        return snapshot;
      },
      subscribe(fn) {
        listener = fn;
        return () => {};
      },
      subscribeEvents: () => () => {},
    });
    await capability.startWeixin(createWeixinQrController);
    snapshot = { ...snapshot, hello: { auth: { role: "operator", scopes: ["operator.read"] } } };
    listener(snapshot);
    expect(capability.state.weixinLogin).toEqual(initialWeixinQrState());
    await capability.startWeixin(createWeixinQrController);
    expect(request.mock.calls.filter(([method]) => method === "web.login.start")).toHaveLength(1);
    capability.dispose();
  });
});
