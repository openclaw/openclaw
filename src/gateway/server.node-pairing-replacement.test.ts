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
    expect(await connectReq(operator, { token: "secret", prePairDevice: true })).toMatchObject({
      ok: true,
    });
    const obsolete = await openTrackedWs(port);
    const replacement = await openTrackedWs(port);
    try {
      for (const ws of [obsolete, replacement]) {
        expect(
          await connectReq(ws, {
            token: "secret",
            client,
            role: "node",
            scopes: [],
            prePairDevice: false,
            deviceIdentityPath: paired.identityPath,
          }),
        ).toMatchObject({ ok: true });
      }
      const event = (memoryFreeBytes: number) => ({
        event: "node.host.stats",
        payload: { cpuCount: 4, memoryTotalBytes: 8192, memoryFreeBytes },
      });
      const readNode = async () => {
        const listed = await rpcReq<{
          nodes: Array<{
            nodeId: string;
            connected: boolean;
            hostStats?: { memoryFreeBytes: number };
          }>;
        }>(operator, "node.list", {});
        expect(listed.ok).toBe(true);
        return listed.payload?.nodes.find((node) => node.nodeId === paired.identity.deviceId);
      };
      expect(await rpcReq(replacement, "node.event", event(4096))).toMatchObject({
        ok: true,
        payload: { handled: true, reason: "updated" },
      });
      expect(await readNode()).toMatchObject({
        connected: true,
        hostStats: { memoryFreeBytes: 4096 },
      });
      const closed = once(obsolete, "close", { signal: AbortSignal.timeout(2_000) }).then(
        ([code]) => code,
      );
      // A rejection can arrive before its close frame; both are valid protocol outcomes.
      const rejection = await rpcReq(obsolete, "node.event", event(1024));
      expect(rejection).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", details: { code: "PAIRING_CHANGED" } },
      });
      await expect(closed).resolves.toBe(4001);
      // The old request must not change the replacement's operational state.
      expect(await readNode()).toMatchObject({
        connected: true,
        hostStats: { memoryFreeBytes: 4096 },
      });
      expect(await rpcReq(replacement, "node.event", event(6144))).toMatchObject({
        ok: true,
        payload: { handled: true, reason: "updated" },
      });
      expect(await readNode()).toMatchObject({
        connected: true,
        hostStats: { memoryFreeBytes: 6144 },
      });
    } finally {
      obsolete.close();
      replacement.close();
    }
  });
});
