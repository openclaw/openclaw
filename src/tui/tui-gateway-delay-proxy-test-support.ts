import { type RawData, WebSocket, WebSocketServer } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { createIdempotentCleanup, settleFixtureWork } from "./tui-pty-local-test-support.js";

type DelayedGatewayRpcRequest = {
  type: "req";
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

function decodeGatewayFrame(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return Buffer.from(new Uint8Array(data)).toString("utf8");
}

export async function startGatewayRpcDelayProxy(
  targetUrl: string,
  delayedMethods: readonly string[],
) {
  const gates = new Map(
    delayedMethods.map((method) => [method, { seen: createDeferred(), release: createDeferred() }]),
  );
  const requests: DelayedGatewayRpcRequest[] = [];
  const sockets = new Set<WebSocket>();
  const handlers: Promise<void>[] = [];
  let stopping = false;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });

  const stop = createIdempotentCleanup(async () => {
    stopping = true;
    for (const gate of gates.values()) {
      gate.release.resolve();
    }
    const socketsClosed = settleFixtureWork(
      [...sockets].map(
        (socket) =>
          new Promise<void>((resolve) => {
            if (socket.readyState === WebSocket.CLOSED) {
              resolve();
              return;
            }
            socket.once("close", resolve);
            socket.close();
          }),
      ),
    );
    void socketsClosed.catch(() => {});
    await runQaGatewayFixture(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
      () => socketsClosed,
      () => settleFixtureWork(handlers),
    );
  });

  server.on("connection", (downstream) => {
    if (stopping) {
      downstream.close();
      return;
    }
    const upstream = new WebSocket(targetUrl);
    sockets.add(downstream);
    sockets.add(upstream);
    const queued: Array<{ data: RawData; isBinary: boolean }> = [];
    upstream.on("open", () => {
      if (stopping) {
        return;
      }
      for (const message of queued.splice(0)) {
        upstream.send(message.data, { binary: message.isBinary });
      }
    });
    downstream.on("message", (data, isBinary) => {
      if (stopping) {
        return;
      }
      try {
        const frame = JSON.parse(decodeGatewayFrame(data)) as Partial<DelayedGatewayRpcRequest>;
        if (
          frame.type === "req" &&
          typeof frame.id === "string" &&
          typeof frame.method === "string"
        ) {
          const request = frame as DelayedGatewayRpcRequest;
          requests.push(request);
          gates.get(request.method)?.seen.resolve();
        }
      } catch {
        // Forward malformed frames so the real Gateway remains the protocol authority.
      }
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      } else {
        queued.push({ data, isBinary });
      }
    });
    upstream.on("message", (data, isBinary) => {
      if (stopping) {
        return;
      }
      const handler = (async () => {
        try {
          const frame = JSON.parse(decodeGatewayFrame(data)) as { type?: unknown; id?: unknown };
          if (frame.type === "res" && typeof frame.id === "string") {
            const method = requests.find((request) => request.id === frame.id)?.method;
            const gate = method ? gates.get(method) : undefined;
            if (gate) {
              await gate.release.promise;
            }
          }
        } catch {
          // Forward malformed frames so the real TUI remains the protocol authority.
        }
        if (downstream.readyState === WebSocket.OPEN) {
          downstream.send(data, { binary: isBinary });
        }
      })();
      handlers.push(handler);
      // Observe now; stop() joins these handlers and reports their rejections.
      void handler.catch(() => {});
    });
    downstream.on("close", () => upstream.close());
    upstream.on("close", () => downstream.close());
    downstream.on("error", () => upstream.close());
    upstream.on("error", () => downstream.close());
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Gateway RPC delay proxy did not bind");
    }
    return {
      url: `ws://127.0.0.1:${address.port}`,
      requests,
      waitForRequest: async (method: string) => {
        const gate = gates.get(method);
        if (!gate) {
          throw new Error(`Gateway RPC method is not delayed: ${method}`);
        }
        await gate.seen.promise;
      },
      release: (method: string) => gates.get(method)?.release.resolve(),
      stop,
    };
  } catch (error) {
    return await runQaGatewayFixture(async () => {
      throw error;
    }, stop);
  }
}
