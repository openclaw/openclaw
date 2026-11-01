import { on, once } from "node:events";
import http from "node:http";
import type { Duplex } from "node:stream";
import { expect } from "vitest";
import { WebSocket } from "ws";
import { closeServer, listenLoopback } from "./desktop.test-support.js";
import { handleDesktopObserveUpgrade } from "./observe-bridge.js";
import type { DesktopSessionRegistry } from "./session-registry.js";

export const RFB_VERSION = Buffer.from("RFB 003.008\n", "ascii");
type Cleanups = Array<() => Promise<void>>;

export async function startObserveGateway(
  cleanups: Cleanups,
  registry: Pick<DesktopSessionRegistry, "attachObserver" | "claimStream">,
  beforeObserve?: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => Promise<boolean>,
) {
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      if (!beforeObserve || !(await beforeObserve(req, socket, head))) {
        handleDesktopObserveUpgrade(req, socket, head, { registry });
      }
    })();
  });
  const port = await listenLoopback(server);
  cleanups.push(() => closeServer(server));
  return `ws://127.0.0.1:${port}`;
}

async function connectObserver(cleanups: Cleanups, url: string) {
  const ws = new WebSocket(url);
  const messages = on(ws, "message", { close: ["close"] });
  const nextFrame = async () => {
    const frame: unknown = (await messages.next()).value?.[0];
    if (!Buffer.isBuffer(frame)) {
      throw new Error("expected a binary RFB frame");
    }
    return frame;
  };
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  cleanups.push(async () => ws.terminate());
  await once(ws, "open");
  return { ws, nextFrame, closed };
}

export async function connectRfbObserver(cleanups: Cleanups, url: string) {
  const observer = await connectObserver(cleanups, url);
  expect(await observer.nextFrame()).toEqual(RFB_VERSION);
  // Coalesce version/security replies with exclusive ClientInit.
  observer.ws.send(Buffer.concat([RFB_VERSION, Buffer.from([1, 0])]));
  expect(await observer.nextFrame()).toEqual(Buffer.from([1, 1]));
  return observer;
}
