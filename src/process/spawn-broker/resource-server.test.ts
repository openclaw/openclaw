import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createBrokerNativeResourceServer } from "./resource-server.js";
import type { createBrokerResourceSocket } from "./resource-socket.js";

const boundary = vi.hoisted(() => ({ server: vi.fn(), socket: vi.fn() }));
vi.mock("node:net", () => ({ createServer: boundary.server }));
vi.mock("./resource-socket.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./resource-socket.js")>()),
  createBrokerResourceSocket: boundary.socket,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("joins the same native close after transport loss instead of abandoning or duplicating it", async () => {
  const created = createDeferred();
  const entered = createDeferred();
  const released = createDeferred();
  const close = vi.fn(async () => {
    entered.resolve();
    await released.promise;
  });
  vi.stubGlobal("__openclawResourceRetirementFixture", { close });
  const connected = Object.getOwnPropertyDescriptor(process, "connected");
  Object.defineProperty(process, "connected", { configurable: true, value: true });
  let accept: ((socket: { setTimeout: () => void }) => void) | undefined;
  let peer: Parameters<typeof createBrokerResourceSocket>[1] | undefined;
  const nativeServer = Object.assign(new EventEmitter(), {
    listen: (_endpoint: string, ready: () => void) => ready(),
    close: vi.fn((): void => {
      nativeServer.emit("close");
    }),
  });
  boundary.server.mockImplementation((callback: typeof accept) => {
    accept = callback;
    return nativeServer;
  });
  boundary.socket.mockImplementation(
    (_socket, handlers: Parameters<typeof createBrokerResourceSocket>[1]) => {
      peer = handlers;
      return { send: async () => {}, close: () => handlers.close() };
    },
  );
  const resource = await createBrokerNativeResourceServer({
    endpoint: "synthetic-resource-endpoint",
    secret: "synthetic-resource-secret",
    generation: 1,
    canAdmit: () => true,
    reportParent: async (message) => {
      if (message.type === "resource-created") {
        created.resolve();
      }
    },
  });
  try {
    accept!({ setTimeout() {} });
    peer!.message({
      type: "resource-attach",
      attachment: {
        id: 1,
        endpoint: "synthetic-resource-endpoint",
        secret: "synthetic-resource-secret",
        generation: 1,
        ownerPort: true,
        moduleUrl:
          "data:text/javascript," +
          encodeURIComponent(
            "export function createNativeWorkerResource(){return globalThis.__openclawResourceRetirementFixture;}",
          ),
      },
    });
    await created.promise;
    resource.receive({ type: "resource-close", id: 1, requestId: 1 });
    await entered.promise;
    resource.disconnect();
    let settled = false;
    const closing = resource.close().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    released.resolve();
    await closing;
    expect(resource.size).toBe(0);
    expect(close).toHaveBeenCalledOnce();
    expect(nativeServer.close).toHaveBeenCalledOnce();
  } finally {
    released.resolve();
    await resource.close();
    if (connected) {
      Object.defineProperty(process, "connected", connected);
    } else {
      Reflect.deleteProperty(process, "connected");
    }
  }
});
