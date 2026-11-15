import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { WebSocket } from "../../../packages/gateway-client/src/websocket.js";
import { listenLoopback } from "../../../test/helpers/gateway-integration-fixtures.js";
import { setLoggerOverride } from "../../logging/logger.js";
import { gatewayConnect } from "../server/client-fixtures.test-support.js";
import { gatewayTestTextTransport } from "../server/connection-transport.test-support.js";
import { createNodeDesktopStreamBroker } from "./node-stream-broker.js";
import { handleDesktopObserveUpgrade, mintDesktopObserverToken } from "./observe-bridge.js";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "desktop transport did not settle");
    await delay(5);
  }
}

async function observe(mode: string) {
  const received: Buffer[] = [];
  let releaseWrite: (() => void) | undefined;
  let released = 0;
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
    });
  });
  const url = await listenLoopback(server, "ws");
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

    const closed = once(client, "close");
    if (mode === "observer-backpressure") {
      client.send(Buffer.from("first"));
      await until(() => Boolean(releaseWrite));
      client.send(Buffer.from("second"));
      await delay(25);
      assert.equal(stream.writableLength, 5);
      assert.equal(Buffer.concat(received).toString(), "first");
      const firstWrite = releaseWrite;
      releaseWrite = undefined;
      firstWrite?.();
      await until(() => Boolean(releaseWrite));
      assert.equal(Buffer.concat(received).toString(), "firstsecond");
      closeObserver?.(1012, "desktop stopped");
    } else if (mode === "observer-payload") {
      client.send(Buffer.alloc(1024 * 1024 + 1));
    } else {
      client.close();
    }
    const [code] = await closed;
    if (mode === "observer-backpressure") {
      assert.equal(code, 1012);
    }
    if (mode === "observer-payload") {
      assert.equal(code, 1009);
      assert.equal(received.length, 0);
    }
    await until(() => stream.destroyed && released === 1);
  } finally {
    client.terminate();
    stream.destroy();
    await promisify(server.close.bind(server))();
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
          socket: gatewayTestTextTransport(client),
          usesSharedGatewayAuth: false,
          connect: gatewayConnect(undefined, { id: "node-host", mode: "node" }, 1, "node"),
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
  const url = await listenLoopback(server, "ws");
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
    await promisify(server.close.bind(server))();
  }
}

export async function runDesktopWebSocketRuntimeProbe(mode: string) {
  setLoggerOverride({
    level: "silent",
    consoleLevel: "silent",
    file: path.join(process.cwd(), "desktop-runtime.log"),
  });
  await (mode === "desktop" || mode === "portal" ? nodeStream(mode) : observe(mode));
}
