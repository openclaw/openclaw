// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../gateway.ts";
import { loadKalshiDashboard, type KalshiDashboardState } from "./kalshi-dashboard.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function createState(request: unknown): KalshiDashboardState {
  return {
    client: { request } as unknown as GatewayBrowserClient,
    kalshiDashboard: null,
    kalshiDashboardError: null,
    kalshiDashboardLastFetchAt: null,
    kalshiDashboardLoading: false,
  };
}

describe("loadKalshiDashboard", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("coalesces concurrent workspace requests", async () => {
    const pending = deferred<{ live_order_allowed: false }>();
    const request = vi.fn(() => pending.promise);
    const state = createState(request);

    const first = loadKalshiDashboard(state, { view: "workspace" });
    const second = loadKalshiDashboard(state, { view: "workspace" });

    expect(request).toHaveBeenCalledTimes(1);
    expect(state.kalshiDashboardLoading).toBe(true);

    pending.resolve({ live_order_allowed: false });
    await Promise.all([first, second]);

    expect(state.kalshiDashboard).toEqual({ live_order_allowed: false });
    expect(state.kalshiDashboardLoading).toBe(false);
  });

  it("skips duplicate workspace refreshes while the snapshot is fresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const request = vi.fn(async () => ({ live_order_allowed: false }));
    const state = createState(request);

    await loadKalshiDashboard(state, { view: "workspace" });
    vi.setSystemTime(5_000);
    await loadKalshiDashboard(state, { view: "workspace" });

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps background polling quiet so the manual refresh button is not stuck", async () => {
    const request = vi.fn(async () => ({ live_order_allowed: false, quiet: true }));
    const state = createState(request);

    await loadKalshiDashboard(state, { quiet: true, view: "workspace" });

    expect(state.kalshiDashboardLoading).toBe(false);
    expect(state.kalshiDashboard).toEqual({ live_order_allowed: false, quiet: true });
  });

  it("passes force refresh to the gateway when explicitly requested", async () => {
    const request = vi.fn(async () => ({ live_order_allowed: false, refreshed: true }));
    const state = createState(request);

    await loadKalshiDashboard(state, { force: true, view: "workspace" });

    expect(request).toHaveBeenCalledWith(
      "kalshi.dashboard.snapshot",
      { force_refresh: true, view: "workspace" },
      { timeoutMs: 15_000 },
    );
    expect(state.kalshiDashboard).toEqual({ live_order_allowed: false, refreshed: true });
  });

  it("lets a full dashboard request upgrade after a workspace request finishes", async () => {
    const workspace = deferred<{ live_order_allowed: false; compact: true }>();
    const request = vi
      .fn()
      .mockReturnValueOnce(workspace.promise)
      .mockResolvedValueOnce({ live_order_allowed: false, full: true });
    const state = createState(request);

    const first = loadKalshiDashboard(state, { view: "workspace" });
    const second = loadKalshiDashboard(state, { view: "full" });

    workspace.resolve({ live_order_allowed: false, compact: true });
    await Promise.all([first, second]);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "kalshi.dashboard.snapshot",
      { view: "workspace" },
      { timeoutMs: 15_000 },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "kalshi.dashboard.snapshot",
      {
        audit_tables: {
          overdue: { page: 1, query: "" },
          pending: { page: 1, query: "" },
          recent: { page: 1, query: "" },
          resolved: { page: 1, query: "" },
        },
      },
      { timeoutMs: 15_000 },
    );
    expect(state.kalshiDashboard).toEqual({ live_order_allowed: false, full: true });
  });
});
