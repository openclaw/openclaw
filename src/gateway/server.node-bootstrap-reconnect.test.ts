// Bootstrap retries must reuse unchanged node grants and their pairing generation.
import { expect, test } from "vitest";
import { issueDeviceBootstrapToken } from "../infra/device-bootstrap.js";
import { captureNodePairingGeneration } from "../infra/device-pairing-node-state.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { listDevicePairing } from "../infra/device-pairing.js";
import {
  CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
} from "../shared/device-bootstrap-profile.js";
import { openTrackedWs, pairDeviceIdentity } from "./device-authz.test-helpers.js";
import { describeWithGatewayServer } from "./server.node-pairing.test-support.js";
import { connectReq, installGatewayTestHooks } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describeWithGatewayServer("node bootstrap reconnect", (getStarted) => {
  test.each([
    ["node-only", NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE],
    ["cloud-worker", CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE],
  ] as const)("reuses the approved pairing for a %s profile", async (name, profile) => {
    const client = {
      id: "node-host" as const,
      version: "1.0.0",
      platform: "linux",
      mode: "node" as const,
    };
    const paired = await pairDeviceIdentity({
      name: `bootstrap-reconnect-${name}`,
      role: "node",
      scopes: [],
      clientId: client.id,
      clientMode: client.mode,
      platform: client.platform,
    });
    const surface = await requestNodePairing({
      nodeId: paired.identity.deviceId,
      platform: client.platform,
      commands: [],
    });
    await approveNodePairing(surface.request.requestId, { callerScopes: ["operator.pairing"] });
    const generation = await captureNodePairingGeneration(paired.identity.deviceId);
    expect(generation).not.toBeNull();
    const issued = await issueDeviceBootstrapToken({ profile });
    const ws = await openTrackedWs(getStarted().port);
    try {
      const response = await connectReq(ws, {
        client,
        role: "node",
        scopes: [],
        bootstrapToken: issued.token,
        skipDefaultAuth: true,
        prePairDevice: false,
        deviceIdentityPath: paired.identityPath,
      });
      expect.soft(response).toMatchObject({
        ok: true,
        payload: { type: "hello-ok", auth: { role: "node", scopes: [] } },
      });
      expect(await captureNodePairingGeneration(paired.identity.deviceId)).toEqual(generation);
      expect(
        (await listDevicePairing()).pending.filter(
          (request) => request.deviceId === paired.identity.deviceId,
        ),
      ).toEqual([]);
    } finally {
      ws.close();
    }
  });
});
