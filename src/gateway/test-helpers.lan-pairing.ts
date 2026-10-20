// Self-connect from the LAN address, not loopback; unavailable interfaces skip the suite.
import net from "node:net";
import { afterAll, beforeAll, describe } from "vitest";
import { WebSocket } from "ws";
import { acquireGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { getPairedDevice, removePairedDevice } from "../infra/device-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { loadDeviceIdentity } from "./device-authz.test-helpers.js";
import { pickPrimaryLanIPv4 } from "./net.js";
import { connectReq, startServer, trackConnectChallengeNonce } from "./test-helpers.js";

const LAN_NODE_PAIRING_TOKEN = "secret";

const NODE_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.NODE_HOST,
  version: "1.0.0",
  platform: "ios",
  mode: GATEWAY_CLIENT_MODES.NODE,
};

async function canUseLanSelfConnect(host: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let client: net.Socket | undefined;
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.end("ok");
    });
    const done = (ok: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      client?.destroy();
      server.close(() => resolve(ok));
    };
    const timer = setTimeout(() => done(false), 1_000);
    server.once("error", () => done(false));
    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        done(false);
        return;
      }
      let sawData = false;
      client = net.connect({ host, port: address.port, localAddress: host });
      client.on("data", () => {
        sawData = true;
      });
      client.once("error", () => done(false));
      client.once("close", () => done(sawData));
    });
  });
}

type LanNodePairingContext = {
  lanIp: string;
  loaded: ReturnType<typeof loadDeviceIdentity>;
  connectNode: () => ReturnType<typeof connectReq>;
};

type LanNodePairingAttempt = (params: {
  identityName: string;
  configure?: (lanIp: string) => Promise<void>;
  run: (ctx: LanNodePairingContext) => Promise<void>;
}) => Promise<void>;

// Each new WebSocket observes config changes while sharing the suite Gateway.
export function describeWithLanNodePairingServer(
  name: string,
  defineTests: (attempt: LanNodePairingAttempt) => void,
): void {
  describe(name, () => {
    let lanIp: string | undefined;
    let started: Awaited<ReturnType<typeof startServer>> | undefined;
    const openSockets = new Set<WebSocket>();

    beforeAll(async () => {
      const candidate = pickPrimaryLanIPv4();
      if (!candidate || !(await canUseLanSelfConnect(candidate))) {
        return;
      }
      lanIp = candidate;
      started = await startServer(LAN_NODE_PAIRING_TOKEN, {
        bind: "lan",
        controlUiEnabled: false,
      });
    });

    afterAll(async () => {
      for (const ws of openSockets) {
        ws.terminate();
      }
      await started?.server.close();
      started?.envSnapshot.restore();
    });

    defineTests(async (params) => {
      const activeServer = started;
      const host = lanIp;
      if (!activeServer || !host) {
        return;
      }
      await params.configure?.(host);
      const loaded = loadDeviceIdentity(params.identityName);
      // A sibling's paired row would preserve stale approvedVia on re-approval.
      if (await getPairedDevice(loaded.identity.deviceId)) {
        await removePairedDevice(loaded.identity.deviceId);
      }
      const connectNode = async () => {
        const ws = new WebSocket(`ws://${host}:${activeServer.port}`, { localAddress: host });
        trackConnectChallengeNonce(ws);
        await acquireGatewayTestWebSocket(ws, 10_000);
        openSockets.add(ws);
        try {
          return await connectReq(ws, {
            token: LAN_NODE_PAIRING_TOKEN,
            role: "node",
            scopes: [],
            client: NODE_CLIENT,
            deviceIdentityPath: loaded.identityPath,
          });
        } finally {
          // Pairing is complete; do not wait for a client close handshake during cleanup.
          openSockets.delete(ws);
          ws.terminate();
        }
      };
      await params.run({ lanIp: host, loaded, connectNode });
    });
  });
}
