// Production-path e2e: a paired node client sends `node.event location.update`
// over a real gateway WebSocket and the gateway's dispatch contract holds:
// a valid fix reaches the registered consumer exactly once with the typed
// payload, a malformed fix is rejected before any consumer runs, and a
// retired registry stops dispatch with `no_consumer`.
//
// The consumer here is a test stub registered through core plugin-registry
// surfaces only: core tests may not deep-import bundled extensions
// (src/plugins/contracts/boundary-invariants.test.ts). The full chain from
// this event to a fired intent and its routed wake — with the real
// memory-core consumer — is covered by the extension's own integration
// suites (extensions/memory-core/src/location-intent-consumer.test.ts and
// location-intents.test.ts), which own those internals.
import { afterAll, beforeAll, expect, test } from "vitest";
import { requestNodePairing, approveNodePairing } from "../infra/device-pairing-node.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  setActivePluginRegistry,
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
} from "../plugins/runtime.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { pairDeviceIdentity } from "./device-authz.test-helpers.js";
import {
  createNodePairingTestState,
  describeWithGatewayServer,
} from "./server.node-pairing.test-support.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const { cleanup: cleanupNodePairingTestState, setup: setupNodePairingTestState } =
  createNodePairingTestState("openclaw-location-update-e2e-");

const inside = { lat: 57.69747, lon: 11.95073, accuracyMeters: 10, source: "e2e" };
const outside = { lat: 57.6991, lon: 11.9505, accuracyMeters: 10, source: "e2e" };

/** A gateway-validated fix exactly as the consumer contract receives it. */
type LocationFix = { lat: number; lon: number; accuracyMeters: number; source: string };

/** Registers a recording consumer through the same registry the gateway reads at dispatch time. */
function activateRecordingConsumer(): {
  registry: PluginRegistry;
  received: Array<{ nodeId: string; payload: LocationFix }>;
} {
  const registry = createEmptyPluginRegistry();
  const received: Array<{ nodeId: string; payload: LocationFix }> = [];
  registry.nodeEventConsumers.push({
    pluginId: "location-e2e-test",
    source: "test",
    subscription: {
      events: ["location.update"],
      handle: (delivery: { nodeId: string; payload: unknown }) => {
        received.push({
          nodeId: delivery.nodeId,
          payload: delivery.payload as LocationFix,
        });
      },
    },
  });
  setActivePluginRegistry(registry);
  return { registry, received };
}

describeWithGatewayServer("gateway location.update e2e (paired node WebSocket)", (getStarted) => {
  let registrySnapshot: ReturnType<typeof captureActivePluginRegistrySnapshot> | undefined;

  beforeAll(async () => {
    await setupNodePairingTestState();
    // NOTE: the gateway's own startup activates its plugin registry, so the
    // consumer registry is published per-test (below), after boot.
  });

  afterAll(async () => {
    if (registrySnapshot) {
      restoreActivePluginRegistrySnapshot(registrySnapshot);
    }
    await cleanupNodePairingTestState();
  });

  test("delivers validated fixes to the registered consumer over the node WebSocket", async () => {
    const started = getStarted();
    registrySnapshot = captureActivePluginRegistrySnapshot();
    const { received } = activateRecordingConsumer();
    const identity = await pairDeviceIdentity({
      name: "location-update-e2e-node",
      role: "node",
      scopes: [],
      clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientMode: GATEWAY_CLIENT_MODES.NODE,
    });
    const pairing = await requestNodePairing({
      nodeId: identity.deviceId,
      platform: "macos",
      deviceFamily: "Mac",
      commands: [],
    });
    const approved = await approveNodePairing(pairing.request.requestId, {
      callerScopes: ["operator.pairing", "operator.write", "operator.admin"],
    });
    expect(approved).toMatchObject({ node: { nodeId: identity.deviceId } });

    await using cleanup = new AsyncDisposableStack();
    const node = await connectGatewayClient({
      url: `ws://127.0.0.1:${started.port}`,
      token: "secret",
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: "location e2e node",
      clientVersion: "1.0.0",
      platform: "macos",
      deviceFamily: "Mac",
      mode: GATEWAY_CLIENT_MODES.NODE,
      scopes: [],
      commands: [],
      deviceIdentity: identity,
    });
    cleanup.defer(() => node.stopAndWait());

    const nodeId = identity.deviceId;

    // Valid baseline fix through the real WebSocket: validated, dispatched,
    // and handed to the consumer with the typed payload and sender node id.
    const baseline = await node.request("node.event", {
      event: "location.update",
      payload: inside,
    });
    expect(baseline).toMatchObject({ ok: true, handled: true, reason: "dispatched" });
    expect(received).toEqual([{ nodeId, payload: inside }]);

    // A second distinct fix is also delivered; dispatch does not dedupe or
    // transform coordinates on the gateway side.
    const crossing = await node.request("node.event", {
      event: "location.update",
      payload: outside,
    });
    expect(crossing).toMatchObject({ ok: true, handled: true, reason: "dispatched" });
    expect(received).toEqual([
      { nodeId, payload: inside },
      { nodeId, payload: outside },
    ]);

    // Malformed payload: rejected before any consumer runs.
    const beforeMalformed = received.length;
    const malformed = await node.request("node.event", {
      event: "location.update",
      payload: { lat: 91, lon: 11.95073, accuracyMeters: 10, source: "e2e" },
    });
    expect(malformed).toMatchObject({ ok: true, handled: false, reason: "invalid_payload" });
    expect(received).toHaveLength(beforeMalformed);

    // Retired registry generation: the subscription goes with the registry,
    // so the same valid fix is now a validated drop.
    const retired = createEmptyPluginRegistry();
    setActivePluginRegistry(retired);
    const afterRetire = await node.request("node.event", {
      event: "location.update",
      payload: inside,
    });
    expect(afterRetire).toMatchObject({ ok: true, handled: false, reason: "no_consumer" });
    expect(received).toHaveLength(beforeMalformed);
  });
});
