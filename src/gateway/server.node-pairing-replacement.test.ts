import { once } from "node:events";
import { expect, test } from "vitest";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { openTrackedWs, pairDeviceIdentity } from "./device-authz.test-helpers.js";
import { describeWithGatewayServer } from "./server.node-pairing.test-support.js";
import { connectReq, installGatewayTestHooks, rpcReq } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describeWithGatewayServer("replaced node connection recovery", (getStarted) => {
  test("closes the obsolete socket while its same-device replacement remains usable", async () => {
    const client = { id: "node-host", version: "1.0.0", platform: "linux", mode: "node" } as const;
    const paired = await pairDeviceIdentity({
      name: "replaced-node",
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
    const { port, ws: operator } = getStarted();
    expect((await connectReq(operator)).ok).toBe(true);
    const obsolete = await openTrackedWs(port);
    const replacement = await openTrackedWs(port);
    try {
      for (const ws of [obsolete, replacement]) {
        expect(
          (
            await connectReq(ws, {
              client,
              role: "node",
              scopes: [],
              prePairDevice: false,
              deviceIdentityPath: paired.identityPath,
            })
          ).ok,
        ).toBe(true);
      }
      const closed = once(obsolete, "close").then(([code]) => ({ kind: "closed", code }));
      const event = { event: "test.pairing-replacement", payload: {} };
      const staleRequest = rpcReq(obsolete, "node.event", event).then(
        (response) => ({ kind: "response", response }),
        () => closed,
      );
      expect(await Promise.race([closed, staleRequest])).toEqual({ kind: "closed", code: 4001 });
      await staleRequest;
      expect(await rpcReq(replacement, "node.event", event)).toMatchObject({
        ok: true,
        payload: { handled: false, reason: "unsupported_event" },
      });
      const listed = await rpcReq<{ nodes: Array<{ nodeId: string; connected: boolean }> }>(
        operator,
        "node.list",
        {},
      );
      expect(listed.payload?.nodes.find((node) => node.nodeId === paired.identity.deviceId)).toMatchObject({
        connected: true,
      });
    } finally {
      obsolete.close();
      replacement.close();
    }
  });
});
