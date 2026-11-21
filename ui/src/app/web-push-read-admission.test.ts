/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../test-helpers/application-context-fixtures.ts";
import { createWebPushCapability } from "./web-push.ts";

const owners = vi.hoisted(() => ({
  viewed: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("./web-push.runtime.ts", () => ({
  createWebPushCapabilityRuntime: () => ({
    viewed: owners.viewed,
    dispose: owners.dispose,
    pending: false,
    run: async () => {},
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each(["stable", "client", "unresolved-profile", "url", "dispose"])(
  "binds a visibility receipt before lazy runtime admission: %s",
  async (change) => {
    vi.stubGlobal("navigator", { userAgent: "", serviceWorker: {} });
    vi.stubGlobal("PushManager", {});
    vi.stubGlobal("Notification", { permission: "granted" });
    const h = createApplicationGateway(
      createApplicationGatewaySnapshot({
        phase: "connected",
        client: {} as GatewayBrowserClient,
        selfUser: null,
      }),
    );
    const capability = createWebPushCapability(h.gateway);
    const completion = {
      agentId: "a",
      sessionKey: "agent:a:s",
      runId: "run",
      messageId: "key:final",
    };
    const presented = vi.fn(() => true);
    capability.viewed(completion, presented);
    if (change === "client") {
      h.publish({ ...h.gateway.snapshot, client: {} as GatewayBrowserClient });
    } else if (change === "unresolved-profile") {
      h.publish({ ...h.gateway.snapshot, selfUser: undefined });
    } else if (change === "url") {
      h.gateway.connection.gatewayUrl += "/replacement";
    } else if (change === "dispose") {
      capability.dispose();
    }
    // Uses the same initialization promise as viewed(), not a timing/polling guess.
    await capability.run({ kind: "test" });
    if (change === "stable") {
      expect(owners.viewed).toHaveBeenCalledWith(completion, expect.any(Function));
      h.publish({ ...h.gateway.snapshot, phase: "offline" });
      expect(owners.viewed.mock.calls[0][1]()).toBe(false);
    } else {
      expect(owners.viewed).not.toHaveBeenCalled();
    }
    if (change !== "dispose") {
      capability.dispose();
    }
  },
);
