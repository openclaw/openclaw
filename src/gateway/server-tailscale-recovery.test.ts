import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { TailscaleRouteOwnershipConflictError } from "../infra/tailscale-route-ownership-error.js";

const mocks = vi.hoisted(() => ({
  claimTailscaleRoute: vi.fn(),
  getTailnetHostname: vi.fn(async () => null),
  getTailnetHostnameAfterServe: vi.fn<() => Promise<string | null>>(async () => null),
  hasTailscaleFunnelRouteForPort: vi.fn(async () => false),
}));
// mock-isolation: Keep real subprocess creation out of the fake-clock lifecycle cases.
vi.mock("../infra/tailscale.js", () => mocks);

import { startGatewayTailscaleExposure } from "./server-tailscale.js";
import { getTailscalePublishedOrigin } from "./tailscale-published-origin.js";

describe("managed Tailscale claim recovery", () => {
  const logTailscale = { info: vi.fn(), warn: vi.fn() };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    mocks.getTailnetHostname.mockResolvedValue(null);
    mocks.getTailnetHostnameAfterServe.mockResolvedValue(null);
    mocks.hasTailscaleFunnelRouteForPort.mockResolvedValue(false);
  });
  function expose(params: Partial<Parameters<typeof startGatewayTailscaleExposure>[0]> = {}) {
    return startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      backend: { host: "127.0.0.1", port: 19000 },
      logTailscale,
      ...params,
    });
  }
  afterEach(() => vi.useRealTimers());

  function recoverableClaim() {
    const exited = createDeferred();
    let active = true;
    const exit = () => {
      active = false;
      exited.resolve();
    };
    return {
      exited: exited.promise,
      isActive: () => active,
      stop: vi.fn(async () => exit()),
      exit,
    };
  }

  it("keeps retrying transient failures while the daemon returns", async () => {
    const original = recoverableClaim();
    const replacement = recoverableClaim();
    mocks.claimTailscaleRoute
      .mockResolvedValueOnce(original)
      .mockRejectedValueOnce(new Error("Tailscale is stopped"))
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(replacement);
    mocks.getTailnetHostnameAfterServe.mockResolvedValue("fixture.tailnet.ts.net");
    const startup = new AbortController();
    const cleanup = await expose({ signal: startup.signal });
    startup.abort();
    try {
      const previousOrigin = getTailscalePublishedOrigin();
      original.exit();
      await vi.advanceTimersByTimeAsync(0);
      expect(previousOrigin?.signal.aborted).toBe(true);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await vi.advanceTimersToNextTimerAsync();
        expect(getTailscalePublishedOrigin()).toBeUndefined();
      }
      await vi.advanceTimersToNextTimerAsync();
      expect(getTailscalePublishedOrigin()?.origin).toBe("https://fixture.tailnet.ts.net");
      expect(mocks.claimTailscaleRoute).toHaveBeenCalledTimes(4);
    } finally {
      await cleanup?.();
    }
  });

  it("stops retrying when another owner has claimed the HTTPS port", async () => {
    const original = recoverableClaim();
    mocks.claimTailscaleRoute
      .mockResolvedValueOnce(original)
      .mockRejectedValue(new TailscaleRouteOwnershipConflictError());
    const cleanup = await expose();
    try {
      original.exit();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersToNextTimerAsync();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(mocks.claimTailscaleRoute).toHaveBeenCalledTimes(2);
      expect(getTailscalePublishedOrigin()).toBeUndefined();
      expect(logTailscale.warn).toHaveBeenCalledWith(expect.stringContaining("already owned"));
    } finally {
      await cleanup?.();
    }
  });

  it("cancels a pending backoff when the Gateway closes", async () => {
    const original = recoverableClaim();
    mocks.claimTailscaleRoute.mockResolvedValueOnce(original);
    const cleanup = await expose();
    original.exit();
    await vi.advanceTimersByTimeAsync(0);
    await cleanup?.();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.claimTailscaleRoute).toHaveBeenCalledOnce();
    expect(getTailscalePublishedOrigin()).toBeUndefined();
  });

  it.each([false, true])(
    "joins replacement cleanup during shutdown (cleanup fails=%s)",
    async (cleanupFails) => {
      const original = recoverableClaim();
      const replacement = recoverableClaim();
      const cleanupError = new Error("claim process could not be stopped");
      if (cleanupFails) {
        replacement.stop.mockRejectedValue(cleanupError);
      }
      mocks.claimTailscaleRoute.mockResolvedValueOnce(original).mockResolvedValueOnce(replacement);
      const hostname = createDeferred<string>();
      mocks.getTailnetHostnameAfterServe
        .mockResolvedValueOnce("fixture.tailnet.ts.net")
        .mockReturnValueOnce(hostname.promise);
      const cleanup = await expose();
      try {
        original.exit();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersToNextTimerAsync();
        expect(mocks.getTailnetHostnameAfterServe).toHaveBeenCalledTimes(2);
        if (cleanupFails) {
          await expect(cleanup?.()).rejects.toMatchObject({
            name: "AggregateError",
            cause: cleanupError,
          });
        } else {
          await cleanup?.();
        }
        expect(replacement.stop).toHaveBeenCalledOnce();
        hostname.resolve("late.tailnet.ts.net");
        await vi.advanceTimersByTimeAsync(120_000);
        expect(getTailscalePublishedOrigin()).toBeUndefined();
        expect(mocks.claimTailscaleRoute).toHaveBeenCalledTimes(2);
      } finally {
        hostname.resolve("late.tailnet.ts.net");
      }
    },
  );
});
