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
import type {
  ControlUiSettingsContext,
  ControlUiSettingsSnapshot,
} from "../../../src/plugin-sdk/control-ui-settings.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { GatewayBrowserClient, type GatewayHelloOk } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { ControlUiSettingsPresentation } from "./control-ui-settings-view.solid.tsx";

afterEach(() => vi.unstubAllGlobals());

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
            auth: { role: "operator", scopes },
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
  let mounted: ReturnType<typeof mountSolid> | undefined;
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
    let snapshot: ControlUiSettingsSnapshot = {
      agentId: "main",
      agentsLoading: false,
      agentsError: null,
      engine: { kind: "default", id: "memory-core", availability: "enabled" },
      connected: true,
      connectionEpoch: 1,
      routeIntent: "overview",
      locale: "en",
    };
    const listeners = new Set<() => void>();
    const runtime = new AbortController();
    const context = createDeferred<ControlUiSettingsContext>();
    const application = {
      gateway: { snapshot: { phase: "connected", hello: connected, client } },
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
    mounted = mountSolid(() => (
      <ControlUiSettingsPresentation
        application={application}
        placement={{ section: "memory", panel: "overview" }}
        readSnapshot={() => snapshot}
        subscribe={(listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }}
        navigate={() => {}}
        refreshAgents={() => {}}
      />
    ));
    return {
      client,
      frames,
      held,
      close,
      context: await withinTest(context.promise, signal),
      retire(cause: string) {
        if (cause === "runtime") {
          runtime.abort();
        } else {
          snapshot = {
            ...snapshot,
            ...(cause === "agent" ? { agentId: "writer" } : { connectionEpoch: 2 }),
          };
          for (const notify of listeners) {
            notify();
          }
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

it.for(["agent", "connection", "runtime"])(
  "fences real transport dispatch and replies after %s retirement",
  async (cause, { signal }) => {
    const f = await transportFixture(["operator.read"], signal);
    try {
      await expect(f.context.request("doctor.memory.status", { agentId: "main" })).resolves.toEqual(
        { marker: "doctor.memory.status" },
      );
      expect(
        f.frames
          .filter((frame) => frame.method === "doctor.memory.status")
          .map(({ params }) => params),
      ).toEqual([{ agentId: "main" }]);
      const pending = f.context.request("doctor.memory.status", { agentId: "main", hold: true });
      const reply = await withinTest(f.held.promise, signal);
      f.retire(cause);
      expect(f.context.signal.aborted).toBe(true);
      await expect(
        f.context.request("doctor.memory.status", { agentId: "main", probe: true }),
      ).rejects.toThrow();
      // An acknowledged frame on the still-connected socket orders the server ledger
      // after the rejected callback; no delay or mocked client can hide a dispatch.
      await f.client.request("health", { barrier: true });
      expect(f.frames.filter((frame) => frame.method === "doctor.memory.status")).toHaveLength(2);
      const rejected = expect(pending).rejects.toThrow();
      sendMinimalGatewayResponse(reply.socket, reply.id, { marker: "retired response" });
      await rejected;
    } finally {
      await f.close();
    }
  },
);

it("rejects an unauthorized caller before any real transport request", async ({ signal }) => {
  const f = await transportFixture([], signal);
  try {
    await expect(f.context.request("doctor.memory.status")).rejects.toThrow("operator access");
    await f.client.request("health", { barrier: true });
    expect(f.frames.map(({ method }) => method)).toEqual(["connect", "health"]);
  } finally {
    await f.close();
  }
});
