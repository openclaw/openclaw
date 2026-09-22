import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi, type TestContext } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { GatewayClient, type GatewayClientOptions } from "../../src/gateway/client.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../../src/gateway/minimal-gateway.test-helpers.js";
import { acquireGatewayTestClient, GatewayTestClientCleanupError } from "./gateway-client.js";
import { createDeferred, withTestTimeout } from "./promise.js";

type AcquisitionWait = Parameters<typeof acquireGatewayTestClient>[1];
type Connection = {
  socket: WebSocket;
  frame: ReturnType<typeof parseMinimalGatewayRequestFrame>;
};
type AcquisitionPeer = {
  acquire: (
    wait?: Partial<AcquisitionWait>,
    onHelloOk?: GatewayClientOptions["onHelloOk"],
  ) => Promise<GatewayClient>;
  connection: Promise<Connection>;
  reconnection: Promise<Connection>;
  sendHello: (connection: Connection) => void;
  startCount: () => number;
  stopCount: () => number;
  socketStopped: Promise<void>;
  releaseStop: () => void;
};

function withAcquisitionPeer(
  context: Pick<TestContext, "onTestFinished">,
  body: (peer: AcquisitionPeer) => Promise<void>,
  options: { holdStop?: boolean; stopError?: Error } = {},
) {
  let cleanup: Promise<void> | undefined;
  const work = Promise.resolve().then(async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const connection = createDeferred<Connection>();
    const reconnection = createDeferred<Connection>();
    const socketStopped = createDeferred();
    void connection.promise.catch(() => {});
    void reconnection.promise.catch(() => {});
    void socketStopped.promise.catch(() => {});
    const stopRelease = createDeferred();
    const clients = new Set<GatewayClient>();
    const acquisitions: Promise<GatewayClient>[] = [];
    const stops: Promise<void>[] = [];
    // oxlint-disable-next-line typescript/unbound-method -- Capture before spying; every call supplies the actual client via .call.
    const nativeStart = GatewayClient.prototype.start;
    // oxlint-disable-next-line typescript/unbound-method -- Capture before spying; every call supplies the actual client via .call.
    const nativeStop = GatewayClient.prototype.stopAndWait;
    let stopCount = 0;
    let firstConnection = true;
    if (!options.holdStop) {
      stopRelease.resolve();
    }
    const startSpy = vi
      .spyOn(GatewayClient.prototype, "start")
      .mockImplementation(function (this: GatewayClient) {
        clients.add(this);
        nativeStart.call(this);
      });
    const stopSpy = vi
      .spyOn(GatewayClient.prototype, "stopAndWait")
      .mockImplementation(function (this: GatewayClient, stopOptions) {
        const completion = (async () => {
          stopCount += 1;
          await nativeStop.call(this, stopOptions);
          socketStopped.resolve();
          // Hold completion after the real socket stop, never instead of stopping it.
          await stopRelease.promise;
          if (options.stopError) {
            throw options.stopError;
          }
        })();
        stops.push(completion);
        void completion.catch((error: unknown) => socketStopped.reject(error));
        return completion;
      });
    server.on("connection", (socket) => {
      sendMinimalGatewayConnectChallenge(socket);
      socket.on("message", (data) => {
        const frame = parseMinimalGatewayRequestFrame(data);
        if (frame.method === "connect") {
          const pendingConnection = firstConnection ? connection : reconnection;
          firstConnection = false;
          pendingConnection.resolve({ socket, frame });
        } else if (frame.id) {
          sendMinimalGatewayResponse(socket, frame.id, { retained: true });
        }
      });
    });
    try {
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Acquisition peer did not bind");
      }
      await body({
        acquire(wait, onHelloOk) {
          const acquisition = acquireGatewayTestClient(
            {
              url: `ws://127.0.0.1:${address.port}`,
              token: "qa-acquisition-token",
              deviceIdentity: null,
              clientName: "cli",
              mode: "cli",
              role: "operator",
              scopes: ["operator.read"],
              onHelloOk,
            },
            {
              timeoutMs: 1_000,
              timeoutMessage: "Acquisition peer did not send hello",
              closeMessage: "Acquisition peer closed",
              ...wait,
            },
          );
          acquisitions.push(acquisition);
          void acquisition.catch((error: unknown) => connection.reject(error));
          return acquisition;
        },
        connection: connection.promise,
        reconnection: reconnection.promise,
        sendHello({ socket, frame }) {
          if (!frame.id) {
            throw new Error("Acquisition connect request omitted its id");
          }
          sendMinimalGatewayResponse(socket, frame.id, buildMinimalGatewayHelloOkPayload());
        },
        startCount: () => startSpy.mock.calls.length,
        stopCount: () => stopCount,
        socketStopped: socketStopped.promise,
        releaseStop: () => stopRelease.resolve(),
      });
    } finally {
      cleanup = (async () => {
        stopRelease.resolve();
        // The pre-fix helper ignores abort. Stop every started client and close
        // the owned peer so even a failed regression joins its acquisition.
        const results = await Promise.allSettled(
          [...clients].map((client) => nativeStop.call(client, { timeoutMs: 1_000 })),
        );
        try {
          await closeMinimalGatewayServer(server);
        } finally {
          await Promise.allSettled(acquisitions);
          await Promise.allSettled(stops);
        }
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length) {
          throw new AggregateError(failures, "Acquisition peer cleanup failed");
        }
      })();
      try {
        await cleanup;
      } finally {
        startSpy.mockRestore();
        stopSpy.mockRestore();
      }
    }
  });
  context.onTestFinished(async () => {
    await work.catch(() => {});
    await cleanup;
  });
  return work;
}

it("does not start a client for an already-aborted acquisition", (context) =>
  withAcquisitionPeer(context, async (peer) => {
    const reason = new Error("cancel before acquisition");
    const controller = new AbortController();
    controller.abort(reason);
    const acquisition = peer.acquire({ signal: controller.signal });
    await setImmediate();
    expect(peer.startCount()).toBe(0);
    await expect(acquisition).rejects.toBe(reason);
  }));

it("joins a cancelled hello acquisition before rejecting and refuses a late hello", (context) =>
  withAcquisitionPeer(
    context,
    async (peer) => {
      const controller = new AbortController();
      const reason = new Error("cancel pending hello");
      const onHelloOk = vi.fn();
      const acquisition = peer.acquire({ signal: controller.signal }, onHelloOk);
      let settled = false;
      void acquisition.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const connection = await peer.connection;
      controller.abort(reason);
      peer.sendHello(connection);
      await setImmediate();
      expect(peer.stopCount()).toBe(1);
      await peer.socketStopped;
      expect(settled).toBe(false);
      expect(onHelloOk).not.toHaveBeenCalled();
      peer.releaseStop();
      await expect(acquisition).rejects.toBe(reason);
    },
    { holdStop: true },
  ));

it("retains acquisition ownership when the caller aborts inside its hello callback", (context) =>
  withAcquisitionPeer(context, async (peer) => {
    const controller = new AbortController();
    const reason = new Error("cancel at hello handoff");
    const onHelloOk = vi.fn(() => controller.abort(reason));
    const acquisition = peer.acquire({ signal: controller.signal }, onHelloOk);
    const connection = await peer.connection;
    expect(connection.frame.params).toMatchObject({
      role: "operator",
      scopes: ["operator.read"],
      client: { id: "cli", mode: "cli" },
    });
    peer.sendHello(connection);
    await expect(acquisition).rejects.toBe(reason);
    expect(onHelloOk).toHaveBeenCalledOnce();
    expect(peer.stopCount()).toBe(1);
  }));

it("keeps caller hello callbacks on reconnect after successful handoff and later abort", (context) =>
  withAcquisitionPeer(context, async (peer) => {
    const controller = new AbortController();
    const verifyCleanup = vi.fn((cleanup: () => Promise<void>) => cleanup());
    const reconnected = createDeferred();
    let helloCount = 0;
    const onHelloOk = vi.fn(() => {
      if (++helloCount === 2) {
        reconnected.resolve();
      }
    });
    const acquisition = peer.acquire({ signal: controller.signal, verifyCleanup }, onHelloOk);
    const connection = await peer.connection;
    peer.sendHello(connection);
    const client = await acquisition;
    controller.abort(new Error("cancel after handoff"));
    connection.socket.close(1012, "synthetic reconnect");
    peer.sendHello(await withTestTimeout(peer.reconnection, 5_000, "client did not reconnect"));
    await withTestTimeout(reconnected.promise, 1_000, "caller did not receive reconnect hello");
    expect(onHelloOk).toHaveBeenCalledTimes(2);
    await expect(client.request("retained", {}, { timeoutMs: 1_000 })).resolves.toEqual({
      retained: true,
    });
    expect(peer.stopCount()).toBe(0);
    expect(verifyCleanup).not.toHaveBeenCalled();
  }));

it("suppresses a cancelled acquisition's late hello while rollback has not started", (context) =>
  withAcquisitionPeer(context, async (peer) => {
    const controller = new AbortController();
    const reason = new Error("cancel with rollback registered but held");
    const releaseCleanup = createDeferred();
    const onHelloOk = vi.fn();
    const verifyCleanup = vi.fn(async (cleanup: () => Promise<void>) => {
      await releaseCleanup.promise;
      await cleanup();
    });
    const acquisition = peer.acquire({ signal: controller.signal, verifyCleanup }, onHelloOk);
    let handedOff = false;
    void acquisition.then(
      () => {
        handedOff = true;
      },
      () => {},
    );
    try {
      const connection = await peer.connection;
      controller.abort(reason);
      expect(verifyCleanup).toHaveBeenCalledOnce();
      expect(peer.stopCount()).toBe(0);
      const pong = once(connection.socket, "pong", { signal: AbortSignal.timeout(1_000) });
      peer.sendHello(connection);
      connection.socket.ping("after-late-hello");
      // The roundtrip follows hello on the same live socket; no native stop can
      // conceal a late callback while the verifier still holds the rollback.
      await pong;
      expect(onHelloOk).not.toHaveBeenCalled();
      expect(handedOff).toBe(false);
      expect(peer.stopCount()).toBe(0);
    } finally {
      releaseCleanup.resolve();
      await acquisition.catch(() => {});
    }
    await expect(acquisition).rejects.toBe(reason);
    expect(peer.stopCount()).toBe(1);
  }));

it("registers failed acquisition rollback before stop and retains its separate failure", (context) =>
  withAcquisitionPeer(
    context,
    async (peer) => {
      const controller = new AbortController();
      const reason = new Error("cancel before failed rollback");
      const registered: Promise<void>[] = [];
      const verifyCleanup = vi.fn((cleanup: () => Promise<void>) => {
        expect(peer.stopCount()).toBe(0);
        const completion = Promise.resolve().then(cleanup);
        registered.push(completion);
        void completion.catch(() => {});
        return completion;
      });
      const acquisition = peer.acquire({ signal: controller.signal, verifyCleanup });
      await peer.connection;
      expect(verifyCleanup).not.toHaveBeenCalled();
      controller.abort(reason);
      await setImmediate();
      expect(verifyCleanup).toHaveBeenCalledOnce();
      await peer.socketStopped;
      peer.releaseStop();
      await expect(acquisition).rejects.toBeInstanceOf(GatewayTestClientCleanupError);
      await expect(acquisition).rejects.toMatchObject({ errors: [reason, rollbackError] });
      await expect(registered[0]).rejects.toBe(rollbackError);
    },
    { holdStop: true, stopError: rollbackError },
  ));

const rollbackError = new Error("synthetic failure after native client stop");
