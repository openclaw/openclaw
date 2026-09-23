import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "../../../packages/gateway-client/src/websocket.js";
import { setLoggerOverride } from "../../logging/logger.js";
import { createNodeDesktopStreamBroker } from "./node-stream-broker.js";
import { handleDesktopObserveUpgrade, mintDesktopObserverToken } from "./observe-bridge.js";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "desktop transport did not settle");
    await delay(5);
  }
}

async function listen(server: http.Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `ws://127.0.0.1:${address.port}`;
}

async function observe(mode: string) {
  const received: Buffer[] = [];
  let releaseWrite: (() => void) | undefined;
  let released = 0;
  let gatewaySocket: WebSocket | undefined;
  let closeObserver: ((code: number, reason: string) => void) | undefined;
  const stream = new Duplex({
    writableHighWaterMark: 1,
    read() {},
    write(chunk, _encoding, callback) {
      received.push(Buffer.from(chunk));
      releaseWrite = callback;
    },
  });
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => {
    handleDesktopObserveUpgrade(req, socket, head, {
      registry: {
        claimStream: () => stream,
        attachObserver: (_sourceKey, observer) => {
          closeObserver = (code, reason) => observer.close(code, reason);
          return { release: () => released++ };
        },
      },
      getBufferedAmount: (ws) => {
        gatewaySocket = ws;
        return ws.bufferedAmount;
      },
    });
  });
  const url = await listen(server);
  const { token } = mintDesktopObserverToken({
    sourceKey: "worker:runtime-proof",
    ownerEpoch: 1,
    control: true,
    attachment: { kind: "stream", streamId: "runtime-proof" },
  });
  const client = new WebSocket(`${url}/desktop/observe?token=${token}`);
  try {
    await once(client, "open");
    const banner = once(client, "message");
    stream.push(Buffer.from("RFB 003.008\n"));
    assert.equal((await banner)[0].toString(), "RFB 003.008\n");

    if (mode === "observer-backpressure") {
      client.send(Buffer.from("first"));
      await until(() => Boolean(releaseWrite));
      assert.equal(gatewaySocket?.isPaused, true);
      client.send(Buffer.from("second"));
      await delay(25);
      assert.equal(stream.writableLength, 5);
      assert.equal(Buffer.concat(received).toString(), "first");
      const firstWrite = releaseWrite;
      releaseWrite = undefined;
      firstWrite?.();
      await until(() => Boolean(releaseWrite));
      assert.equal(Buffer.concat(received).toString(), "firstsecond");
      assert.equal(gatewaySocket?.isPaused, true);
      const closed = once(client, "close");
      closeObserver?.(1012, "desktop stopped");
      assert.equal((await closed)[0], 1012);
    } else if (mode === "observer-payload") {
      const closed = once(client, "close");
      client.send(Buffer.alloc(1024 * 1024 + 1));
      assert.equal((await closed)[0], 1009);
      assert.equal(received.length, 0);
    } else {
      const closed = once(client, "close");
      client.close();
      await closed;
    }
    await until(() => stream.destroyed && released === 1);
  } finally {
    client.terminate();
    stream.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

async function nodeStream(kind: "desktop" | "portal") {
  const broker = createNodeDesktopStreamBroker();
  const binding = { nodeId: "runtime-node", connId: "runtime-connection", pairingGeneration: "1" };
  const ticket = kind === "desktop" ? broker.mint(binding) : broker.mintPortal(binding);
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => {
    void broker.handleUpgrade(req, socket, head, {
      getForPairingGeneration: () => ({
        ...binding,
        client: {
          connId: binding.connId,
          socket: client,
          usesSharedGatewayAuth: false,
          connect: {
            minProtocol: 1,
            maxProtocol: 1,
            client: { id: "node-host", version: "test", platform: "test", mode: "node" },
          },
        },
        declaredCaps: [],
        caps: [],
        declaredCommands: [],
        commands: [],
        declaredNodePluginTools: [],
        nodePluginTools: [],
        nodeSkills: [],
        connectedAtMs: 0,
      }),
      isConnectionCurrentPairingState: async () => true,
    });
  });
  const url = await listen(server);
  const client = new WebSocket(`${url}${ticket.attachPath}`);
  let stream: Duplex | undefined;
  try {
    await once(client, "open");
    client.send(
      Buffer.from(JSON.stringify(kind === "desktop" ? { auth: "vnc-password" } : { ok: true })),
    );
    ({ stream } = await ticket.attached);
    const incoming = once(stream, "data");
    client.send(Buffer.from("node-to-gateway"));
    assert.equal((await incoming)[0].toString(), "node-to-gateway");
    const outgoing = once(client, "message");
    stream.write(Buffer.from("gateway-to-node"));
    assert.equal((await outgoing)[0].toString(), "gateway-to-node");
    const closed = once(client, "close");
    stream.on("error", () => undefined);
    client.send(Buffer.alloc(64 * 1024 + 1));
    assert.equal((await closed)[0], 1009);
    await until(() => Boolean(stream?.destroyed));
  } finally {
    client.terminate();
    stream?.destroy();
    ticket.cancel();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

export async function runDesktopWebSocketRuntimeProbe(mode: string) {
  setLoggerOverride({
    level: "silent",
    consoleLevel: "silent",
    file: path.join(process.cwd(), "desktop-runtime.log"),
  });
  if (mode === "desktop" || mode === "portal") {
    await nodeStream(mode);
  } else {
    await observe(mode);
  }
}
