import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { getDashboardState, subscribeToDashboardEvents } from "../../lib/dashboard/index.ts";
import { stopDashboard } from "./dashboard-controller.ts";

describe("dashboard controller", () => {
  it("stops the live-update subscription for its host", () => {
    const host = {};
    const state = getDashboardState(host);
    const unsubscribe = vi.fn();
    const client = {
      request: vi.fn(),
      addEventListener: vi.fn(() => unsubscribe),
    } as unknown as GatewayBrowserClient;
    subscribeToDashboardEvents(host, state, client);
    stopDashboard(host);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for a host that never subscribed", () => {
    expect(() => stopDashboard({})).not.toThrow();
  });
});
