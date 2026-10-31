import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { GatewayClient, GatewayClientOptions } from "../../src/gateway/client.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../../src/gateway/minimal-gateway.test-helpers.js";
import { createOpenClawTestInstance } from "./openclaw-test-instance.js";
import { awaitGateBeforeSettlement, createDeferred } from "./promise.js";

afterEach(() => {
  vi.doUnmock("../../src/gateway/client.js");
  vi.restoreAllMocks();
  vi.resetModules();
});

type PeerMode = "connect failure" | "success" | "retry" | "deadline";

async function withStatusPeer(
  mode: PeerMode,
  stopError: Error | undefined,
  body: (fixture: {
    instance: Awaited<ReturnType<typeof createOpenClawTestInstance>>;
    clients: Array<{ stopJoined: boolean }>;
    firstStop: ReturnType<typeof createDeferred<void>>;
    secondClient: ReturnType<typeof createDeferred<void>>;
    releaseStop: ReturnType<typeof createDeferred<void>>;
    statusReplies: readonly [Promise<void>, Promise<void>, Promise<void>];
  }) => Promise<void>,
) {
  const clients: Array<{ stopJoined: boolean; stop: () => Promise<void> }> = [];
  const firstStop = createDeferred();
  const secondClient = createDeferred();
  const releaseStop = createDeferred();
  const statusReplies = [createDeferred(), createDeferred(), createDeferred()] as const;
  let statusReplyCount = 0;
  const stopping: Promise<void>[] = [];
  vi.doMock("../../src/gateway/client.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/gateway/client.js")>();
    class ObservedGatewayClient extends actual.GatewayClient {
      constructor(options: GatewayClientOptions) {
        super(options);
        const stop = this.stopAndWait.bind(this);
        const entry = { stopJoined: false, stop: () => stop() };
        clients.push(entry);
        if (clients.length === 2) {
          secondClient.resolve();
        }
        this.stopAndWait = (stopOptions) => {
          // Hold the real stop's completion, not its socket, to expose an unjoined owner.
          const operation = (async () => {
            if (entry === clients[0]) {
              firstStop.resolve();
            }
            await stop(stopOptions);
            await releaseStop.promise;
            if (stopError) {
              throw stopError;
            }
            entry.stopJoined = true;
          })();
          stopping.push(operation);
          return operation;
        };
        const request = this.request.bind(this);
        this.request = async <T>(...args: Parameters<GatewayClient["request"]>): Promise<T> => {
          const reply = await request<T>(...args);
          if (args[0] === "node.list") {
            statusReplies[statusReplyCount++]?.resolve();
          }
          return reply;
        };
      }
    }
    return { ...actual, GatewayClient: ObservedGatewayClient };
  });
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 64 * 1024 });
  let connection = 0;
  wss.on("connection", (ws) => {
    const ordinal = ++connection;
    sendMinimalGatewayConnectChallenge(ws);
    ws.on("message", (data) => {
      const frame = parseMinimalGatewayRequestFrame(data);
      if (!frame.id) {
        throw new Error("status request omitted id");
      }
      if (
        (frame.method === "connect" && mode === "connect failure") ||
        (frame.method === "node.list" && mode === "retry" && ordinal === 1)
      ) {
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: false,
            error: { code: "UNAVAILABLE", message: "synthetic status failure" },
          }),
        );
      } else if (frame.method === "connect") {
        sendMinimalGatewayResponse(ws, frame.id, buildMinimalGatewayHelloOkPayload());
      } else if (frame.method === "node.list") {
        sendMinimalGatewayResponse(ws, frame.id, {
          nodes:
            mode === "deadline"
              ? []
              : [{ nodeId: "synthetic-node", connected: true, paired: true }],
        });
      }
    });
  });
  let instance: Awaited<ReturnType<typeof createOpenClawTestInstance>> | undefined;
  try {
    await once(wss, "listening");
    const address = wss.address();
    if (!address || typeof address === "string") {
      throw new Error("status peer did not bind");
    }
    instance = await createOpenClawTestInstance({ name: "status-acquisition", port: address.port });
    instance.state.applyEnv();
    const { loadDeviceAuthToken } = await import("../../src/infra/device-auth-store.js");
    const { loadOrCreateDeviceIdentity } = await import("../../src/infra/device-identity.js");
    // Complete real auth worker startup before measuring hello and polling lifetimes.
    await loadDeviceAuthToken({
      deviceId: loadOrCreateDeviceIdentity().deviceId,
      role: "operator",
    });
    await body({
      instance,
      clients,
      firstStop,
      secondClient,
      releaseStop,
      statusReplies: [statusReplies[0].promise, statusReplies[1].promise, statusReplies[2].promise],
    });
  } finally {
    releaseStop.resolve();
    // Drain even clients the broken helper never adopted; bypass only the observer.
    await Promise.all(clients.map((entry) => entry.stop()));
    await Promise.allSettled(stopping);
    await closeMinimalGatewayServer(wss);
    await instance?.cleanup();
  }
}

it.each([
  ["connect failure", false],
  ["success", false],
  ["retry", false],
  ["deadline", false],
  ["connect failure", true],
  ["success", true],
  ["retry", true],
] as const)(
  "joins cleanup before %s settlement or reacquisition (stop fails=%s)",
  async (mode, stopFails) => {
    const stopError = stopFails ? new Error("synthetic stop failure") : undefined;
    await withStatusPeer(mode, stopError, async (fixture) => {
      const { connectGatewayStatusClient, waitForNodeStatus } =
        await import("./gateway-e2e-harness.js");
      const startedAt = Date.now();
      const clock =
        mode === "deadline" ? vi.spyOn(Date, "now").mockReturnValue(startedAt) : undefined;
      let settled = false;
      const operation =
        mode === "connect failure" && !stopFails
          ? connectGatewayStatusClient(fixture.instance)
          : waitForNodeStatus(fixture.instance, "synthetic-node");
      const result = operation.then(
        () => undefined,
        (error: unknown) => error,
      );
      void result.then(() => {
        settled = true;
      });
      try {
        if (clock) {
          // Advance only the polling clock, after real replies; native socket timers stay live.
          const premature = Promise.race([fixture.firstStop.promise, result]);
          for (const [elapsed, reply] of [
            [0, fixture.statusReplies[0]],
            [14_999, fixture.statusReplies[1]],
          ] as const) {
            clock.mockReturnValue(startedAt + elapsed);
            await awaitGateBeforeSettlement(
              reply,
              premature,
              `polling must remain active at ${elapsed}ms`,
            );
          }
          clock.mockReturnValue(startedAt + 15_000);
          await awaitGateBeforeSettlement(
            fixture.firstStop.promise,
            Promise.race([fixture.statusReplies[2], result]),
            "the default deadline must stop polling at 15000ms",
          );
        }
        await Promise.race([result, fixture.firstStop.promise, fixture.secondClient.promise]);
        await setImmediate();
        const settledBeforeStop = settled;
        const acquiredBeforeStop = fixture.clients.length;
        fixture.releaseStop.resolve();
        const outcome = await result;
        if (stopError) {
          if (mode === "success") {
            expect(outcome).toBe(stopError);
          } else {
            expect(outcome).toBeInstanceOf(AggregateError);
            expect(outcome).toMatchObject({
              errors: [{ message: "synthetic status failure" }, stopError],
            });
          }
        } else if (mode === "connect failure") {
          expect(outcome).toMatchObject({ message: "synthetic status failure" });
        } else if (mode === "deadline") {
          expect(outcome).toMatchObject({
            message: "timeout waiting for node status for synthetic-node",
          });
        } else {
          expect(outcome).toBeUndefined();
        }
        expect(settledBeforeStop).toBe(false);
        expect(acquiredBeforeStop).toBe(1);
        expect(fixture.clients).toHaveLength(mode === "retry" && !stopFails ? 2 : 1);
        if (!stopFails) {
          expect(fixture.clients.every((entry) => entry.stopJoined)).toBe(true);
        }
      } finally {
        // Finish an admitted poll even when a boundary assertion fails, then restore wall time.
        clock?.mockReturnValue(startedAt + 30_000);
        fixture.releaseStop.resolve();
        try {
          await result;
        } finally {
          clock?.mockRestore();
        }
      }
    });
  },
);
