import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { writeConfigFile } from "../config/config.js";
import { getPairedDevice, listDevicePairing } from "../infra/device-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { loadDeviceIdentity } from "./device-authz.test-helpers.js";
import { pickPrimaryLanIPv4 } from "./net.js";
import {
  connectReq,
  installGatewayTestHooks,
  startServer,
  trackConnectChallengeNonce,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const TOKEN = "secret";
const NODE_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.NODE_HOST,
  version: "1.0.0",
  platform: "ios",
  mode: GATEWAY_CLIENT_MODES.NODE,
};

async function openLanGatewayWs(params: { host: string; port: number }): Promise<WebSocket> {
  const ws = new WebSocket(`ws://${params.host}:${params.port}`);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for ws open")), 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
  return ws;
}

describe("gateway trusted CIDR node pairing auto-approve", () => {
  test("stays disabled by default for a direct non-loopback node", async () => {
    const lanIp = pickPrimaryLanIPv4();
    if (!lanIp) {
      return;
    }
    const started = await startServer(TOKEN, { bind: "lan", controlUiEnabled: false });
    let ws: WebSocket | undefined;
    try {
      const loaded = loadDeviceIdentity("trusted-cidr-default-off");
      ws = await openLanGatewayWs({ host: lanIp, port: started.port });
      const res = await connectReq(ws, {
        token: TOKEN,
        role: "node",
        scopes: [],
        client: NODE_CLIENT,
        deviceIdentityPath: loaded.identityPath,
      });

      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("pairing required");
      const pending = (await listDevicePairing()).pending.filter(
        (entry) => entry.deviceId === loaded.identity.deviceId,
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]?.silent).toBe(false);
      expect(await getPairedDevice(loaded.identity.deviceId)).toBeNull();
    } finally {
      ws?.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("auto-approves first-time node pairing from a matching direct non-loopback CIDR", async () => {
    const lanIp = pickPrimaryLanIPv4();
    if (!lanIp) {
      return;
    }
    await writeConfigFile({
      gateway: {
        nodes: {
          pairing: {
            autoApproveCidrs: [`${lanIp}/32`],
          },
        },
      },
    });
    const started = await startServer(TOKEN, { bind: "lan", controlUiEnabled: false });
    let ws: WebSocket | undefined;
    try {
      const loaded = loadDeviceIdentity("trusted-cidr-direct-lan-auto-approve");
      ws = await openLanGatewayWs({ host: lanIp, port: started.port });
      const res = await connectReq(ws, {
        token: TOKEN,
        role: "node",
        scopes: [],
        client: NODE_CLIENT,
        deviceIdentityPath: loaded.identityPath,
      });

      expect(res.ok).toBe(true);
      expect((res.payload as { type?: unknown } | undefined)?.type).toBe("hello-ok");
      const pending = (await listDevicePairing()).pending.filter(
        (entry) => entry.deviceId === loaded.identity.deviceId,
      );
      expect(pending).toHaveLength(0);
      const paired = await getPairedDevice(loaded.identity.deviceId);
      expect(paired?.role).toBe("node");
      expect(paired?.approvedScopes ?? []).toEqual([]);
    } finally {
      ws?.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
