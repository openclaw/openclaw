import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import {
  WebSocket,
  WebSocketServer,
} from "../../../packages/gateway-client/src/websocket.test-support.ts";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../../../src/gateway/minimal-gateway.test-helpers.js";
import type { ControlUiSettingsContext } from "../../../src/plugin-sdk/control-ui-settings.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { GatewayBrowserClient, type GatewayHelloOk } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import { mountSettingsPresentation } from "./control-ui-settings.test-support.tsx";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try {
    for (const close of cleanups.splice(0)) {
      await close();
    }
  } finally {
    vi.unstubAllGlobals();
  }
});

async function transportFixture(scopes: string[], signal: AbortSignal) {
  vi.stubGlobal("WebSocket", WebSocket);
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const frames: Array<{ id: string; method: string; params: unknown }> = [];
  const held = createDeferred<{ socket: WebSocket; id: string }>();
  server.on("connection", (socket) => {
    sendMinimalGatewayConnectChallenge(socket);
    socket.on("message", (raw) => {
      const frame = parseMinimalGatewayRequestFrame(raw);
      if (frame.type !== "req" || !frame.id || !frame.method) {
        return;
      }
      frames.push({ id: frame.id, method: frame.method, params: frame.params });
      if (frame.method === "connect") {
        sendMinimalGatewayResponse(
          socket,
          frame.id,
          buildMinimalGatewayHelloOkPayload({
            auth: { role: "operator", scopes, recoveryScope: "account-a" },
            methods: ["doctor.memory.status", "memory.search", "health"],
          }),
        );
      } else if (frame.params?.hold === true) {
        held.resolve({ socket, id: frame.id });
      } else {
        sendMinimalGatewayResponse(socket, frame.id, { marker: frame.method });
      }
    });
  });
  let client: GatewayBrowserClient | undefined;
  let mounted: ReturnType<typeof mountSettingsPresentation> | undefined;
  const close = async () => {
    mounted?.unmount();
    client?.stop();
    await closeMinimalGatewayServer(server);
  };
  try {
    await withinTest(once(server, "listening"), signal);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a loopback listener");
    }
    const hello = createDeferred<GatewayHelloOk>();
    client = new GatewayBrowserClient({
      url: `ws://127.0.0.1:${address.port}`,
      onHello: hello.resolve,
    });
    client.start();
    const connected = await withinTest(hello.promise, signal);
    const runtime = new AbortController();
    const context = createDeferred<ControlUiSettingsContext>();
    const gateway = { snapshot: { phase: "connected" as string, hello: connected, client } };
    const application = {
      gateway,
      plugins: {
        reportError: (error: unknown) => {
          throw error;
        },
        async loadSettingsView(_placement: unknown, mountSignal: AbortSignal) {
          return {
            signal: AbortSignal.any([mountSignal, runtime.signal]),
            dispose() {},
            view: {
              placement: { section: "memory", panel: "overview" },
              mount(_container: HTMLElement, value: ControlUiSettingsContext) {
                context.resolve(value);
                return { update() {}, dispose() {} };
              },
            },
          };
        },
      },
    } as unknown as ApplicationContext;
    const presentation = mountSettingsPresentation(application, {
      advertisedMethods: connected.features?.methods,
    });
    mounted = presentation;
    const loadedContext = await withinTest(context.promise, signal);
    cleanups.push(close);
    return {
      client,
      frames,
      held,
      context: loadedContext,
      reconnect(phase: "reconnecting" | "connected", connectionEpoch: number) {
        gateway.snapshot.phase = phase;
        presentation.change({ connected: phase === "connected", connectionEpoch });
      },
      retire(cause: string) {
        if (cause === "runtime") {
          runtime.abort();
        } else if (cause === "account reassignment" || cause === "access revocation") {
          const auth = connected.auth!;
          gateway.snapshot.hello = {
            ...connected,
            auth:
              cause === "account reassignment"
                ? { ...auth, recoveryScope: "account-b" }
                : { ...auth, scopes: [] },
          };
        } else {
          presentation.change(
            cause === "agent" ? { agentId: "writer" } : { advertisedMethods: ["health"] },
          );
          return;
        }
        if (cause !== "runtime") {
          presentation.notify();
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

it.for(["agent", "runtime", "method catalog", "account reassignment", "access revocation"])(
  "fences real transport dispatch and replies after %s retirement",
  async (cause, { signal }) => {
    const method = cause === "method catalog" ? "memory.search" : "doctor.memory.status";
    const f = await transportFixture(["operator.read"], signal);
    await expect(f.context.request(method, { agentId: "main" })).resolves.toEqual({
      marker: method,
    });
    expect(f.frames.filter((frame) => frame.method === method).map(({ params }) => params)).toEqual(
      [{ agentId: "main" }],
    );
    const pending = f.context.request(method, { agentId: "main", hold: true });
    const reply = await withinTest(f.held.promise, signal);
    f.retire(cause);
    expect(f.context.signal.aborted).toBe(true);
    await expect(f.context.request(method, { agentId: "main", probe: true })).rejects.toThrow();
    // An acknowledged frame on the still-connected socket orders the server ledger
    // after the rejected callback; no delay or mocked client can hide a dispatch.
    await f.client.request("health", { barrier: true });
    expect(f.frames.filter((frame) => frame.method === method)).toHaveLength(2);
    const rejected = expect(pending).rejects.toThrow();
    sendMinimalGatewayResponse(reply.socket, reply.id, { marker: "retired response" });
    await rejected;
  },
);

it("keeps the view through a same-client reconnect but rejects the earlier reply", async ({
  signal,
}) => {
  const f = await transportFixture(["operator.read"], signal);
  const pending = f.context.request("memory.search", { agentId: "main", hold: true });
  const reply = await withinTest(f.held.promise, signal);
  f.reconnect("reconnecting", 2);
  f.reconnect("connected", 3);
  const rejected = expect(pending).rejects.toThrow("connection changed");
  sendMinimalGatewayResponse(reply.socket, reply.id, { marker: "previous transport" });
  await rejected;
  expect(f.context.signal.aborted).toBe(false);
  await expect(f.context.request("memory.search", { agentId: "main" })).resolves.toEqual({
    marker: "memory.search",
  });
});

it("rejects an unauthorized caller before any real transport request", async ({ signal }) => {
  const f = await transportFixture([], signal);
  await expect(f.context.request("doctor.memory.status")).rejects.toThrow("operator access");
  await f.client.request("health", { barrier: true });
  expect(f.frames.map(({ method }) => method)).toEqual(["connect", "health"]);
});
