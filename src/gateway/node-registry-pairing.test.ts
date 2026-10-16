import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getCurrentActiveNodeContext,
  prepareActiveNodeContext,
  setActiveNodeContexts,
} from "../infra/active-node-context.js";
import { NodeRegistry } from "./node-registry.js";
import { makeClient, registerNodeSession } from "./node-registry.test-helpers.js";

const registries = new Set<NodeRegistry>();
function createNodeRegistry(options: ConstructorParameters<typeof NodeRegistry>[0]) {
  const registry = new NodeRegistry(options);
  registries.add(registry);
  return registry;
}
afterEach(() => {
  for (const registry of registries) {
    for (const session of registry.listConnected()) {
      registry.unregister(session.connId);
    }
  }
  registries.clear();
  setActiveNodeContexts([]);
});

it.each(["current", "revoked", "unavailable"])(
  "uses the published pairing authority after a delayed read (%s)",
  async (publication) => {
    const lookup = createDeferred<{ identity: string; generation: string }>();
    const frames: string[] = [];
    const client = makeClient("conn-publication", "node-publication", frames);
    let current = true;
    const registry = createNodeRegistry({
      resolveCurrentPairingState: () => lookup.promise,
      isPairingStateCurrent: () => {
        if (!current && publication === "unavailable") {
          throw new Error("pairing publication is pending");
        }
        return current;
      },
    });
    registerNodeSession(registry, client, {
      pairingIdentity: "identity-a",
      pairingGeneration: "generation-a",
    });
    const sent = registry.sendEventForPairingIdentity({
      nodeId: "node-publication",
      connId: "conn-publication",
      pairingIdentity: "identity-a",
      event: "voicewake.changed",
      payload: { triggers: ["hello"] },
    });
    current = publication === "current";
    lookup.resolve({ identity: "identity-a", generation: "generation-a" });
    await expect(sent).resolves.toBe(publication === "current");
    expect(frames).toHaveLength(publication === "current" ? 1 : 0);
    expect(client.invalidated === true).toBe(publication === "revoked");
  },
);

it("refreshes active-node authority before projecting a prompt after external revocation", async () => {
  let published = true;
  let durable = true;
  const registry = createNodeRegistry({
    resolveCurrentPairingState: async () => {
      published = durable;
      return durable ? { identity: "identity-a", generation: "generation-a" } : undefined;
    },
    isPairingStateCurrent: () => published,
  });
  registerNodeSession(
    registry,
    makeClient("conn-prompt", "node-prompt", [], {
      permissions: { accessibility: true },
    }),
    { pairingIdentity: "identity-a", pairingGeneration: "generation-a" },
  );
  registry.updatePresenceActivity({
    nodeId: "node-prompt",
    connId: "conn-prompt",
    idleSeconds: 0,
  });
  expect(getCurrentActiveNodeContext()?.nodeId).toBe("node-prompt");
  durable = false;
  await prepareActiveNodeContext();
  expect(getCurrentActiveNodeContext()).toBeNull();
  expect(registry.listConnected()).toEqual([]);
});
