import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { hasErrnoCode } from "../infra/errno.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import { getDeterministicFreePortBlock } from "../test-utils/ports.js";
import { GatewayStartupCleanupError } from "./server-shutdown.js";
import type { GatewayServer } from "./server.js";

export async function getGatewayTestPort(): Promise<number> {
  return await getDeterministicFreePortBlock({ offsets: [0, 1, 2, 3, 4] });
}

export function canRetryPort(error: unknown): boolean {
  const causes = collectNestedErrorCandidates(error);
  return (
    !causes.some((cause) => cause instanceof GatewayStartupCleanupError) &&
    causes.some((cause) => hasErrnoCode(cause, "EADDRINUSE"))
  );
}

export async function startClaimedGateway(
  port: number | TestPortClaim,
  start: () => Promise<GatewayServer>,
) {
  const claim =
    typeof port === "number"
      ? await acquireTestPortBlock({ port, offsets: [0, 1, 2, 3, 4] })
      : port;
  try {
    const server = await start();
    const close = server.close.bind(server);
    server.close = async (...args) => {
      await close(...args);
      await claim.release();
    };
    return server;
  } catch (error) {
    if (
      !collectNestedErrorCandidates(error).some(
        (cause) => cause instanceof GatewayStartupCleanupError,
      )
    ) {
      await claim.release();
    }
    throw error;
  }
}

type ListenerReservation = {
  listener: ReturnType<typeof createServer>;
  adopt: () => void;
};

async function createListenerDispatcher() {
  const { vi } = await import("vitest");
  const transport = await import("./server-runtime-state.js");
  const createTransport = transport.createGatewayHttpTransport;
  const listeners = new Map<number, ListenerReservation>();
  const spy = vi
    .spyOn(transport, "createGatewayHttpTransport")
    .mockImplementation(async (params) => {
      const reservation = listeners.get(params.port);
      const runtime = await createTransport(
        reservation ? { ...params, testListener: reservation.listener } : params,
      );
      reservation?.adopt();
      return runtime;
    });
  return { listeners, restore: () => spy.mockRestore() };
}

// Overlapping startups share the original constructor and its import. Recapturing
// an installed spy would replace that same mock and make it call itself.
let activeDispatcher:
  | { ready: ReturnType<typeof createListenerDispatcher>; pending: number }
  | undefined;

/** Retain the exact loopback listener until the real Gateway transport adopts it. */
export async function reserveGatewayTestListener(port = 0) {
  const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4], ...(port ? { port } : {}) });
  const listener = createServer();
  const rejectEarlyConnection = (socket: Socket) => socket.destroy();
  listener.on("connection", rejectEarlyConnection);
  let adopted = false;
  const closeUnadopted = async () => {
    if (!adopted && listener.listening) {
      await new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      });
    }
    if (!listener.listening) {
      await claim.release();
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(claim.port, "127.0.0.1", () => {
        listener.off("error", reject);
        resolve();
      });
    });
    const address = listener.address();
    assert(address && typeof address !== "string");
    return {
      port: address.port,
      listener,
      closeUnadopted,
      async start<T>(run: () => Promise<T>): Promise<T> {
        const owner = (activeDispatcher ??= { ready: createListenerDispatcher(), pending: 0 });
        owner.pending++;
        let dispatcher: Awaited<typeof owner.ready> | undefined;
        try {
          dispatcher = await owner.ready;
          assert(
            !dispatcher.listeners.has(address.port),
            "Reserved Gateway listener is already starting",
          );
          dispatcher.listeners.set(address.port, {
            listener,
            adopt: () => {
              adopted = true;
            },
          });
          try {
            const result = await run();
            listener.off("connection", rejectEarlyConnection);
            return result;
          } finally {
            dispatcher.listeners.delete(address.port);
          }
        } finally {
          if (--owner.pending === 0) {
            activeDispatcher = undefined;
            dispatcher?.restore();
          }
        }
      },
    };
  } catch (error) {
    await closeUnadopted();
    throw error;
  }
}
