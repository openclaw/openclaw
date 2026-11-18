import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../api/gateway.ts";
import { createApplicationGatewaySnapshot } from "../test-helpers/application-context-fixtures.ts";
import { ScopeUpgradeOwner } from "./device-scope-upgrade-owner.runtime.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

describe("scope upgrade transport recovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retires an upgrade when the Gateway reports a changed role ceiling", async () => {
    const client = new GatewayBrowserClient({ url: "ws://gateway.test" });
    vi.spyOn(client, "scopeUpgradeReady", "get").mockReturnValue(true);
    const pending = createDeferred<{ status: "expired"; requestId: string }>();
    vi.spyOn(client, "requestScopeUpgrade").mockReturnValue(pending.promise);
    const cancel = vi.spyOn(client, "cancelScopeUpgrade");
    const snapshot = (roleAllowsAdmin: boolean): ApplicationGatewaySnapshot =>
      createApplicationGatewaySnapshot({
        client,
        phase: "connected",
        hello: {
          type: "hello-ok",
          protocol: 3,
          auth: { role: "operator", scopes: ["operator.read"], roleAllowsAdmin },
          features: { methods: ["device.scopes.requestUpgrade", "device.scopes.waitUpgrade"] },
        },
      });
    const owner = new ScopeUpgradeOwner(snapshot(true), vi.fn());
    try {
      owner.request();
      expect(owner.state.phase).toBe("requesting");
      owner.sync(snapshot(false));
      expect(owner.state).toEqual({ phase: "guidance", reason: "role" });
      expect(cancel).toHaveBeenCalledOnce();
      pending.resolve({ status: "expired", requestId: "retired-upgrade" });
      await pending.promise;
      await Promise.resolve();
      expect(owner.state).toEqual({ phase: "guidance", reason: "role" });
      owner.sync(snapshot(true));
      expect(owner.state).toEqual({ phase: "available" });
    } finally {
      owner.dispose();
    }
  });

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
