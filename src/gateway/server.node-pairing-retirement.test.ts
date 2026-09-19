// A stale node pairing must retire the live transport instead of answering every
// dispatch with a retryable error while the node still shows Connected (#148693).
import { expect, test, vi } from "vitest";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { removePairedDevice } from "../infra/device-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { openTrackedWs, pairDeviceIdentity } from "./device-authz.test-helpers.js";
import { describeWithGatewayServer } from "./server.node-pairing.test-support.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { connectOk, installGatewayTestHooks, rpcReq } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

type NodeListEntry = { nodeId: string; connected?: boolean };

async function connectPairedNode(params: { port: number; name: string; commands: string[] }) {
  const paired = await pairDeviceIdentity({
    name: params.name,
    role: "node",
    scopes: [],
    clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
    platform: "macos",
    deviceFamily: "Mac",
  });
  const request = await requestNodePairing({
    nodeId: paired.identity.deviceId,
    platform: "macos",
    deviceFamily: "Mac",
    commands: params.commands,
  });
  await approveNodePairing(request.request.requestId, {
    callerScopes: ["operator.pairing", "operator.write"],
  });
  const client = await connectGatewayClient({
    url: `ws://127.0.0.1:${params.port}`,
    token: "secret",
    role: "node",
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientDisplayName: params.name,
    clientVersion: "1.0.0",
    platform: "macos",
    deviceFamily: "Mac",
    mode: GATEWAY_CLIENT_MODES.NODE,
    scopes: [],
    commands: params.commands,
    deviceIdentity: paired.identity,
    timeoutMessage: `timeout waiting for paired node ${params.name} to connect`,
  });
  return { client, nodeId: paired.identity.deviceId };
}

describeWithGatewayServer("node pairing retirement over the live transport", (getStarted) => {
  test("retires the stale connection and keeps the valid node dispatchable", async () => {
    const started = getStarted();
    const controlWs = await openTrackedWs(started.port);
    await connectOk(controlWs, { token: "secret" });
    const control = controlWs;

    const valid = await connectPairedNode({
      port: started.port,
      name: "retire-valid-node",
      commands: ["system.which"],
    });
    const stale = await connectPairedNode({
      port: started.port,
      name: "retire-stale-node",
      commands: ["system.which"],
    });

    try {
      const connectedNodeIds = async (): Promise<string[]> => {
        const list = await rpcReq<{ nodes?: NodeListEntry[] }>(control, "node.list", {});
        return (list.payload?.nodes ?? [])
          .filter((entry) => entry.connected)
          .map((entry) => entry.nodeId)
          .toSorted();
      };
      await vi.waitFor(async () => {
        const ids = await connectedNodeIds();
        if (!ids.includes(valid.nodeId) || !ids.includes(stale.nodeId)) {
          throw new Error(`both nodes not connected yet: ${JSON.stringify(ids)}`);
        }
      });

      // Revoking the persisted pairing leaves the live connection holding a
      // superseded lease.
      await removePairedDevice(stale.nodeId);

      // The stale dispatch is rejected and the obsolete transport is closed with the
      // invalidation reason, so the client reconnects instead of retrying forever.
      await expect(stale.client.request("node.event", { event: "test" })).rejects.toThrow();

      // The obsolete transport is closed rather than left answering retryable
      // errors, and its presence is retired while the valid node stays up.
      await vi.waitFor(() => {
        expect(stale.client.connected).toBe(false);
      });
      await vi.waitFor(async () => {
        const ids = await connectedNodeIds();
        if (ids.includes(stale.nodeId)) {
          throw new Error(`stale node still listed connected: ${JSON.stringify(ids)}`);
        }
      });
      // The valid node keeps its transport and its connected presence: only the
      // superseded connection is retired.
      expect(valid.client.connected).toBe(true);
      await vi.waitFor(async () => {
        const ids = await connectedNodeIds();
        if (!ids.includes(valid.nodeId)) {
          throw new Error(`valid node dropped from presence: ${JSON.stringify(ids)}`);
        }
      });
    } finally {
      await Promise.allSettled([
        valid.client.stopAndWait({ timeoutMs: 1_000 }),
        stale.client.stopAndWait({ timeoutMs: 1_000 }),
      ]);
      controlWs.close();
    }
  });

  test("retires an obsolete socket without closing its same-device replacement", async () => {
    const started = getStarted();
    const controlWs = await openTrackedWs(started.port);
    await connectOk(controlWs, { token: "secret" });
    const control = controlWs;
    const paired = await pairDeviceIdentity({
      name: "retire-replaced-node",
      role: "node",
      scopes: [],
      clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientMode: GATEWAY_CLIENT_MODES.NODE,
      platform: "macos",
      deviceFamily: "Mac",
    });
    const pairingRequest = await requestNodePairing({
      nodeId: paired.identity.deviceId,
      platform: "macos",
      deviceFamily: "Mac",
      commands: ["system.which"],
    });
    await approveNodePairing(pairingRequest.request.requestId, {
      callerScopes: ["operator.pairing", "operator.write"],
    });
    const connectSameDevice = (displayName: string) =>
      connectGatewayClient({
        url: `ws://127.0.0.1:${started.port}`,
        token: "secret",
        role: "node",
        clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientDisplayName: displayName,
        clientVersion: "1.0.0",
        platform: "macos",
        deviceFamily: "Mac",
        mode: GATEWAY_CLIENT_MODES.NODE,
        scopes: [],
        commands: ["system.which"],
        deviceIdentity: paired.identity,
        timeoutMessage: `timeout waiting for ${displayName}`,
      });
    const obsolete = await connectSameDevice("obsolete-socket");
    const replacement = await connectSameDevice("replacement-socket");
    try {
      // Registering the replacement drops the first connection from the registry while
      // its socket stays open, so that socket's next request resolves stale.
      await expect(obsolete.request("node.event", { event: "test" })).rejects.toThrow();
      await vi.waitFor(() => {
        expect(obsolete.connected).toBe(false);
      });
      // The authorized replacement keeps its transport; the retirement must not reach it.
      expect(replacement.connected).toBe(true);
      await vi.waitFor(async () => {
        const list = await rpcReq<{ nodes?: { nodeId: string; connected?: boolean }[] }>(
          control,
          "node.list",
          {},
        );
        const connectedIds = (list.payload?.nodes ?? [])
          .filter((entry) => entry.connected)
          .map((entry) => entry.nodeId);
        if (!connectedIds.includes(paired.identity.deviceId)) {
          throw new Error(`replacement lost its connection: ${JSON.stringify(connectedIds)}`);
        }
      });
    } finally {
      await Promise.allSettled([
        obsolete.stopAndWait({ timeoutMs: 1_000 }),
        replacement.stopAndWait({ timeoutMs: 1_000 }),
      ]);
      controlWs.close();
    }
  });
});
