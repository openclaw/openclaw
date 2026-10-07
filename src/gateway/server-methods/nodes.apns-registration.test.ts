import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setActiveNodeContexts } from "../../infra/active-node-context.js";
import { ApnsRegistrationPairingChangedError } from "../../infra/push-apns-store.js";
import { NodeRegistry } from "../node-registry.js";
import { makeClient, registerNodeSession } from "../node-registry.test-helpers.js";
import type { handleNodeEvent } from "../server-node-events.js";
import { nodeEventHandlers } from "./nodes.event.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const handleEvent = vi.hoisted(() => vi.fn<typeof handleNodeEvent>());
const isPairingCurrent = vi.hoisted(() => vi.fn(() => true));
vi.mock("../server-node-events.js", () => ({ handleNodeEvent: handleEvent }));
vi.mock("../../infra/device-pairing-node-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/device-pairing-node-state.js")>()),
  captureNodePairingGeneration: async (nodeId: string) => ({ nodeId, key: "generation-a" }),
  isNodePairingGenerationCurrent: async () => true,
  isPairedDeviceNodeBindingCurrent: isPairingCurrent,
}));

const registries = new Set<NodeRegistry>();
afterEach(() => {
  for (const registry of registries) {
    for (const node of registry.listConnected()) {
      registry.unregister(node.connId);
    }
  }
  registries.clear();
  setActiveNodeContexts([]);
  handleEvent.mockReset();
  isPairingCurrent.mockReset().mockReturnValue(true);
});

it.each([
  { event: "push.apns.register", state: "current" },
  { event: "push.apns.register", state: "replacement" },
  { event: "push.apns.register", state: "invalidated" },
  { event: "notifications.changed", state: "current" },
  { event: "notifications.changed", state: "replacement" },
  { event: "notifications.changed", state: "invalidated" },
  { event: "notifications.changed", state: "disconnected" },
  { event: "notifications.changed", state: "generation-replaced" },
  { event: "notifications.changed", state: "pairing-revoked" },
])(
  "binds $event admission to the original live node session ($state)",
  async ({ event, state }) => {
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
    handleEvent.mockImplementation(async (_context, _nodeId, nodeEvent, options) => {
      if (nodeEvent.event === "push.apns.register") {
        expect(await options?.resolveApnsRegistrationGeneration?.()).toBe("generation-a");
      }
      entered.resolve();
      await release.promise;
      const assertCurrent =
        nodeEvent.event === "push.apns.register"
          ? options?.assertApnsRegistrationCurrent
          : options?.assertSessionEventCurrent;
      expect(assertCurrent).toBeTypeOf("function");
      try {
        assertCurrent?.();
        registered = true;
        return undefined;
      } catch (error) {
        if (
          !(error instanceof ApnsRegistrationPairingChangedError) &&
          !(
            error instanceof Error &&
            error.message === "Node pairing changed during session event admission"
          )
        ) {
          throw error;
        }
        return { ok: true, event: nodeEvent.event, handled: false, reason: "pairing_changed" };
      }
    });
    const params = {
      event,
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
    } else if (state === "disconnected") {
      registry.unregister("conn-a");
    } else if (state === "generation-replaced") {
      registerNodeSession(registry, makeClient("conn-a", "node-a"), {
        pairingIdentity: "identity-a",
        pairingGeneration: "generation-b",
      });
    } else if (state === "pairing-revoked") {
      isPairingCurrent.mockReturnValue(false);
    }
    release.resolve();
    await pending;
    const guardedOptions = handleEvent.mock.calls[0]?.[3];
    expect(
      event === "push.apns.register"
        ? guardedOptions?.assertApnsRegistrationCurrent
        : guardedOptions?.assertSessionEventCurrent,
    ).toBeTypeOf("function");
    expect(registered).toBe(state === "current");
    expect(respond.mock.calls[0]?.[0]).toBe(state === "current");
  },
);
