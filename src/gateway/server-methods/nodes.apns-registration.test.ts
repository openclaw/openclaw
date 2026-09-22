import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setActiveNodeContext } from "../../infra/active-node-context.js";
import { ApnsRegistrationPairingChangedError } from "../../infra/push-apns-store.js";
import { NodeRegistry } from "../node-registry.js";
import { makeClient, registerNodeSession } from "../node-registry.test-helpers.js";
import type { handleNodeEvent } from "../server-node-events.js";
import { nodeEventHandlers } from "./nodes.event.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const handleEvent = vi.hoisted(() => vi.fn<typeof handleNodeEvent>());
vi.mock("../server-node-events.js", () => ({ handleNodeEvent: handleEvent }));
vi.mock("../../infra/device-pairing-node-state.js", () => ({
  captureNodePairingGeneration: async (nodeId: string) => ({ nodeId, key: "generation-a" }),
  isNodePairingGenerationCurrent: async () => true,
}));

const registries = new Set<NodeRegistry>();
afterEach(() => {
  for (const registry of registries) {
    for (const node of registry.listConnected()) {
      registry.unregister(node.connId);
    }
  }
  registries.clear();
  setActiveNodeContext(null);
  handleEvent.mockReset();
});

it.each(["current", "replacement", "invalidated"])(
  "binds APNs worker admission to the original live node session (%s)",
  async (state) => {
    const registry = new NodeRegistry();
    registries.add(registry);
    const client = makeClient("conn-a", "node-a");
    registerNodeSession(registry, client, {
      pairingIdentity: "identity-a",
      pairingGeneration: "generation-a",
    });
    const entered = createDeferred();
    const release = createDeferred();
    let registered = false;
    handleEvent.mockImplementation(async (_context, _nodeId, event, options) => {
      expect(await options?.resolveApnsRegistrationGeneration?.()).toBe("generation-a");
      entered.resolve();
      await release.promise;
      expect(options?.assertApnsRegistrationCurrent).toBeTypeOf("function");
      try {
        options?.assertApnsRegistrationCurrent?.();
        registered = true;
        return undefined;
      } catch (error) {
        if (!(error instanceof ApnsRegistrationPairingChangedError)) {
          throw error;
        }
        return { ok: true, event: event.event, handled: false, reason: "pairing_changed" };
      }
    });
    const params = {
      event: "push.apns.register",
      payload: { token: "abcd1234".repeat(4), topic: "ai.openclaw.ios" },
    };
    const respond = vi.fn();
    const pending = nodeEventHandlers["node.event"]!({
      req: { type: "req", id: "apns", method: "node.event", params },
      params,
      client,
      respond,
      isWebchatConnect: () => false,
      context: {
        nodeRegistry: registry,
        logGateway: { warn: vi.fn() },
      } as unknown as GatewayRequestHandlerOptions["context"],
    });
    await entered.promise;
    if (state === "replacement") {
      // Even a reused correlation string cannot give a replacement session the old lease.
      registerNodeSession(registry, makeClient("conn-a", "node-a"), {
        pairingIdentity: "identity-a",
        pairingGeneration: "generation-a",
      });
    } else if (state === "invalidated") {
      registry.invalidateConnectionForPairingChange("conn-a");
    }
    release.resolve();
    await pending;
    expect(registered).toBe(state === "current");
    expect(respond.mock.calls[0]?.[0]).toBe(state === "current");
  },
);
