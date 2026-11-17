// Production-path e2e: a paired node client sends `node.event location.update`
// over a real gateway WebSocket, memory-core's registered consumer evaluates
// the fix against an armed one-shot intent, and exactly one routed system
// event lands on the intent's delivery session. Unmatched fixes produce no
// wake.
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  registerLocationIntentConsumer,
  settleLocationIntentFiresForTest,
} from "../../extensions/memory-core/src/location-intent-consumer.js";
import {
  createLocationStandingIntent,
  listStandingIntents,
} from "../../extensions/memory-core/src/standing-intents.js";
import { requestNodePairing, approveNodePairing } from "../infra/device-pairing-node.js";
import { drainSystemEvents } from "../infra/system-events.js";
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

const DELIVERY_SESSION = "agent:main:main";
const inside = { lat: 57.69747, lon: 11.95073, accuracyMeters: 10, source: "e2e" };
const outside = { lat: 57.6991, lon: 11.9505, accuracyMeters: 10, source: "e2e" };

async function pairNode(name: string) {
  const paired = await pairDeviceIdentity({
    name,
    role: "node",
    scopes: [],
    clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
  });
  const pairing = await requestNodePairing({
    nodeId: paired.identity.deviceId,
    platform: "macos",
    deviceFamily: "Mac",
    commands: [],
  });
  const approved = await approveNodePairing(pairing.request.requestId, {
    callerScopes: ["operator.pairing", "operator.write", "operator.admin"],
  });
  expect(approved).toMatchObject({ node: { nodeId: paired.identity.deviceId } });
  return paired.identity;
}

function expectRegistryWithConsumer(): { registry: PluginRegistry; warnings: string[] } {
  const registry = createEmptyPluginRegistry();
  const warnings: string[] = [];
  const api = {
    registerNodeEventConsumer: (subscription: unknown) => {
      registry.nodeEventConsumers.push({
        pluginId: "memory-core",
        source: "bundled",
        subscription: subscription as PluginRegistry["nodeEventConsumers"][number]["subscription"],
      });
    },
    logger: {
      warn: (message: string) => warnings.push(message),
      info() {},
      error() {},
      debug() {},
    },
    runtime: {
      config: { current: () => ({ agents: { list: [{ id: "main" }] } }) },
    },
  };
  registerLocationIntentConsumer(api as never);
  return { registry, warnings };
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

  test("fires an armed one-shot intent to the routed session and stays silent on replay", async () => {
    const started = getStarted();
    // Publish the real memory-core consumer now — after the gateway booted
    // and installed its own registry — because dispatch reads the active
    // registry at event time.
    registrySnapshot = captureActivePluginRegistrySnapshot();
    // The consumer logs failures via its api logger and fire passes are
    // awaited below, so the returned diagnostics collector stays unused here.
    const { registry } = expectRegistryWithConsumer();
    setActivePluginRegistry(registry);
    const identity = await pairNode("location-update-e2e-node");
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
    expect(await listStandingIntents({ agentId: "main" })).toHaveLength(0);
    await createLocationStandingIntent({
      agentId: "main",
      description: "E2E: buy groceries when leaving lunch.",
      nodeId,
      direction: "exit",
      centerLat: inside.lat,
      centerLon: inside.lon,
      radiusMeters: 55,
      deliveryTarget: DELIVERY_SESSION,
      creatorSender: "owner-sender",
    });

    // Baseline through the real WebSocket: validated, dispatched to the
    // consumer, but no fire on arm and no wake.
    const baseline = await node.request("node.event", {
      event: "location.update",
      payload: inside,
    });
    expect(baseline).toMatchObject({ ok: true, handled: true, reason: "dispatched" });
    // Serialize the fire passes: the consumer dedupes fixes per node while a
    // pass is in flight, so the baseline pass must settle before the
    // crossing fix is sent.
    await settleLocationIntentFiresForTest();

    // Real crossing through the real WebSocket: one routed wake.
    const crossing = await node.request("node.event", {
      event: "location.update",
      payload: outside,
    });
    expect(crossing).toMatchObject({ ok: true, handled: true });
    // The consumer pass is fire-and-forget; settle it before reading the queue.
    await settleLocationIntentFiresForTest();
    // Single drain: the routed wake lands on the recorded session exactly once.
    const wakeTexts = drainSystemEvents(DELIVERY_SESSION);
    expect(wakeTexts).toHaveLength(1);
    expect(wakeTexts[0]).toContain("E2E: buy groceries when leaving lunch.");

    const rows = await listStandingIntents({ agentId: "main" });
    expect(rows.find((row) => row.description.startsWith("E2E:"))?.status).toBe("done");
    const replay = await node.request("node.event", {
      event: "location.update",
      payload: outside,
    });
    expect(replay).toMatchObject({ ok: true, handled: true });
    expect(drainSystemEvents(DELIVERY_SESSION)).toEqual([]);
  });
});
