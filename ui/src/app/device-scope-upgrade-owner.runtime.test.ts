import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "../api/gateway.ts";
import { createApplicationGatewaySnapshot } from "../test-helpers/application-context-fixtures.ts";
import { ScopeUpgradeOwner } from "./device-scope-upgrade-owner.runtime.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

describe("scope upgrade transport recovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps a local failure retryable without inventing an authoritative denial", async () => {
    const client = new GatewayBrowserClient({ url: "ws://gateway.test" });
    vi.spyOn(client, "scopeUpgradeReady", "get").mockReturnValue(true);
    const request = vi
      .spyOn(client, "requestScopeUpgrade")
      .mockRejectedValueOnce(new Error("Connection interrupted"))
      .mockResolvedValueOnce({ status: "expired", requestId: "upgrade-1" });
    const snapshot: ApplicationGatewaySnapshot = createApplicationGatewaySnapshot({
      client,
      phase: "connected",
      hello: {
        type: "hello-ok",
        protocol: 3,
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: ["device.scopes.requestUpgrade", "device.scopes.waitUpgrade"] },
      },
      sessionKey: "agent:main:main",
    });
    const owner = new ScopeUpgradeOwner(snapshot, vi.fn());
    try {
      owner.request();
      await vi.waitFor(() =>
        expect(owner.state).toEqual({
          phase: "error",
          message: "Connection interrupted",
          retryable: true,
        }),
      );
      owner.retry();
      await vi.waitFor(() => expect(owner.state.phase).toBe("rejected"));
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      owner.dispose();
    }
  });
});
