import assert from "node:assert/strict";
import { once, type EventEmitter } from "node:events";
import net, { type Server } from "node:net";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { WebSocket } from "ws";
import { createSuiteLogPathTracker } from "../../logging/log-test-helpers.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { createDiagnosticLogRecordCapture } from "../../logging/test-helpers/diagnostic-log-capture.js";

export async function listenLoopback(server: Server) {
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  assert(address && typeof address !== "string", "expected TCP test address");
  return address.port;
}

export async function closeServer(server: Server) {
  await promisify(server.close.bind(server))();
}

export function waitForClose(emitter: EventEmitter) {
  return new Promise<void>((resolve) => {
    emitter.once("close", () => resolve());
  });
}

export function handlePeerTeardownError(error: NodeJS.ErrnoException): void {
  if (error.code !== "ECONNRESET" && error.code !== "EPIPE") {
    throw error;
  }
}

export async function expectUnauthorizedUpgrade(url: string, cleanup: Array<() => Promise<void>>) {
  const ws = new WebSocket(url);
  cleanup.push(async () => ws.terminate());
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => reject(new Error("unauthorized upgrade was accepted")));
    ws.once("unexpected-response", (_request, response) => {
      expect(response.statusCode).toBe(401);
      response.resume();
      resolve();
    });
    ws.once("error", () => undefined);
  });
}

export function createSocketServer(
  cleanup: Array<() => Promise<void>>,
  accept: (socket: net.Socket) => void,
) {
  const peers = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
    accept(socket);
  });
  cleanup.push(async () => {
    peers.forEach((peer) => peer.destroy());
    await closeServer(server);
  });
  return { server, peers };
}

export function setupDesktopDiagnostics(
  cleanup: Array<() => Promise<void>>,
  prefix: string,
  restoreBeforeCleanup = false,
) {
  const paths = createSuiteLogPathTracker(prefix);
  const captures: ReturnType<typeof createDiagnosticLogRecordCapture>[] = [];
  beforeAll(() => paths.setup());
  beforeEach(() =>
    setLoggerOverride({ level: "info", consoleLevel: "silent", file: paths.nextPath() }),
  );
  afterAll(() => paths.cleanup());
  afterEach(async () => {
    try {
      if (restoreBeforeCleanup) {
        vi.restoreAllMocks();
      }
      await Promise.all(cleanup.splice(0).map((run) => run()));
      await flushLogger();
      await Promise.all(captures.map((capture) => capture.flush()));
      if (vi.isFakeTimers()) {
        expect(vi.getTimerCount()).toBe(0);
      }
    } finally {
      captures.splice(0).forEach((capture) => capture.cleanup());
      resetLogger();
      if (!restoreBeforeCleanup) {
        vi.restoreAllMocks();
      }
      vi.useRealTimers();
    }
  });
  return () => {
    const capture = createDiagnosticLogRecordCapture();
    captures.push(capture);
    return capture;
  };
}
