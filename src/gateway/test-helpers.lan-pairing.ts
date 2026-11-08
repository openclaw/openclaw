import { once } from "node:events";
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

async function canUseLanSelfConnect(host: string): Promise<boolean> {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.end("ok");
  });
  const signal = AbortSignal.timeout(1_000);
  let client: net.Socket | undefined;
  try {
    await once(server.listen(0, "0.0.0.0"), "listening", { signal });
    const address = server.address();
    if (!address || typeof address === "string") {
      return false;
    }
    client = net.connect({ host, port: address.port, localAddress: host });
    client.resume();
    await once(client, "close", { signal });
    return client.bytesRead > 0;
  } catch {
    return false;
  } finally {
    client?.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

type LanNodePairingAttempt = (params: {
  identityName: string;
  configure?: (lanIp: string) => Promise<void>;
  run: (ctx: {
    lanIp: string;
    loaded: ReturnType<typeof loadDeviceIdentity>;
    connectNode: () => ReturnType<typeof connectReq>;
  }) => Promise<void>;
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
            client: {
              id: GATEWAY_CLIENT_NAMES.NODE_HOST,
              version: "1.0.0",
              platform: "ios",
              mode: GATEWAY_CLIENT_MODES.NODE,
            },
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
