import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { NodeRegistry } from "../../node-registry.js";
import type { GatewayRequestOptions } from "../../server-methods/types.js";
import { dispatchProfile } from "../client-fixtures.test-support.js";
import type { GatewayWsClient } from "../ws-types.js";
import { createRequestGate } from "./authenticated-request-dispatch.fixtures.test-support.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
  requestFrame,
} from "./authenticated-request-dispatch.test-support.js";

const handleGatewayRequest = vi.hoisted(() => vi.fn());

vi.mock("./authenticated-request-dispatch.server-methods.runtime.js", () => ({
  handleGatewayRequest,
}));

const activeRegistries = new Set<NodeRegistry>();
const controlUi = { id: GATEWAY_CLIENT_IDS.CONTROL_UI, mode: GATEWAY_CLIENT_MODES.UI };
const cli = { id: GATEWAY_CLIENT_IDS.CLI, mode: GATEWAY_CLIENT_MODES.CLI };
const nodeParams = { nodeId: "paired-node", command: "ollama.chat" };

afterEach(() => {
  for (const registry of activeRegistries) {
    registry.unregister("paired-node-connection");
  }
  activeRegistries.clear();
  handleGatewayRequest.mockReset();
});

function createPairedNode(withError = false) {
  const frames: string[] = [];
  let frameArrived = createDeferredCore();
  const waitForFrameCount = async (count: number) => {
    while (frames.length < count) {
      await frameArrived.promise;
    }
  };
  const registry = new NodeRegistry();
  activeRegistries.add(registry);
  registry.register(
    {
      connId: "paired-node-connection",
      socket: {
        readyState: WebSocket.OPEN,
        send(frame: string | Buffer) {
          frames.push(frame.toString());
          frameArrived.resolve();
          frameArrived = createDeferredCore();
        },
      },
      connect: {
        client: { id: GATEWAY_CLIENT_IDS.NODE_HOST, mode: "node" },
        device: { id: "paired-node" },
        caps: ["local-inference"],
        commands: ["ollama.chat"],
      },
    } as GatewayWsClient,
    { pairingIdentity: "paired-node-identity" },
  );
  handleGatewayRequest.mockImplementation(async (options: GatewayRequestOptions) => {
    const result = await registry.invoke({
      ...nodeParams,
      timeoutMs: 10_000,
      signal: options.signal,
    });
    options.respond(
      result.ok,
      result.payload,
      withError && result.error
        ? {
            code: result.error.code ?? "UNAVAILABLE",
            message: result.error.message ?? "node invocation failed",
          }
        : undefined,
    );
  });
  const complete = (id: string) =>
    registry.handleInvokeResult({
      id,
      nodeId: "paired-node",
      connId: "paired-node-connection",
      ok: true,
    });
  return { registry, frames, waitForFrameCount, complete };
}

const nodeRequest = (id: string) =>
  requestFrame(id, "node.invoke", { ...nodeParams, idempotencyKey: id });

function createDispatcher(
  clientInfo: Pick<GatewayWsClient["connect"]["client"], "id" | "mode"> = cli,
) {
  const socket = new EventEmitter();
  const client = createOperatorWsClient({
    connId: "operator-connection",
    socket,
    clientInfo,
    scopes: ["operator.write"],
  });
  const harness = createDispatchTestHarness({ connId: client.connId });
  return { socket, client, ...harness };
}

describe("authenticated WebSocket request cancellation", () => {
  it.each([
    ["plugins.reload", { plugins: [{ pluginId: "demo" }] }, false],
    ["plugins.reload", { plugins: [{ pluginId: "demo" }], waitForDrain: true }, true],
    ["sessions.usage", { range: "all" }, true],
  ] as const)(
    "binds request-owned %s work to disconnect (%j, cancelled=%s)",
    async (method, params, cancelled) => {
      const { socket, client, dispatcher } = createDispatcher(controlUi);
      const gate = createRequestGate();
      let signal: AbortSignal | undefined;
      handleGatewayRequest.mockImplementation(async (options: GatewayRequestOptions) => {
        signal = options.signal;
        await gate.wait();
      });
      const dispatch = dispatcher.dispatch(requestFrame("disconnect-work", method, params), client);
      await gate.during(dispatch, () => {
        socket.emit("close", 1000, Buffer.alloc(0));
        if (cancelled) {
          expect(signal?.aborted).toBe(true);
        } else {
          expect(signal).toBeUndefined();
        }
      });
      expect(socket.listenerCount("close")).toBe(0);
    },
  );

  it("cancels only access-bound work after a grant ends, including after ordinary disconnect", async () => {
    const { registry, frames, waitForFrameCount, complete } = createPairedNode();
    const guest = createDispatcher(controlUi);
    const staff = createDispatcher(controlUi);
    const profile = dispatchProfile("same-person");
    guest.client.authenticatedUserProfile = profile;
    staff.client.authenticatedUserProfile = profile;
    const grant = new AbortController();
    guest.client.internal = {
      operatorAccessAuthority: {
        signal: grant.signal,
        assertCurrent: () => grant.signal.throwIfAborted(),
      },
    };
    const request = (id: string) =>
      requestFrame(id, "test.access-lifetime", { sessionKey: "agent:main:shared" });
    const guestDispatch = guest.dispatcher.dispatch(request("guest"), guest.client);
    await waitForFrameCount(1);
    const staffDispatch = staff.dispatcher.dispatch(request("staff"), staff.client);
    try {
      await waitForFrameCount(2);
      guest.socket.emit("close", 1006, Buffer.alloc(0));
      expect(frames).toHaveLength(2);
      grant.abort(new Error("Grant ended"));
      await waitForFrameCount(3);
      const guestRequest = JSON.parse(frames[0] ?? "{}") as { payload: { id: string } };
      const staffRequest = JSON.parse(frames[1] ?? "{}") as { payload: { id: string } };
      expect(JSON.parse(frames[2] ?? "{}")).toMatchObject({
        event: "node.invoke.cancel",
        payload: { invokeId: guestRequest.payload.id },
      });
      expect(complete(staffRequest.payload.id)).toBe(true);
      await staff.awaitResponseFrame("staff");
      expect(staff.close).not.toHaveBeenCalled();
    } finally {
      registry.unregister("paired-node-connection");
      await Promise.all([guestDispatch, staffDispatch]);
    }
  });

  it.each([
    ["CLI", cli, true],
    ["control UI", controlUi, false],
  ] as const)(
    "preserves %s node invocation policy on socket close",
    async (_name, info, cancel) => {
      const { registry, frames, waitForFrameCount, complete } = createPairedNode(cancel);
      const { socket, awaitResponseFrame, client, dispatcher } = createDispatcher(info);
      const dispatch = dispatcher.dispatch(nodeRequest("inference"), client);
      try {
        await waitForFrameCount(1);
        expect(socket.listenerCount("close")).toBe(Number(cancel));
        socket.emit("close", 1000, Buffer.alloc(0));
        const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
        if (cancel) {
          await waitForFrameCount(2);
          expect(JSON.parse(frames[1] ?? "{}")).toMatchObject({
            event: "node.invoke.cancel",
            payload: { invokeId: request.payload?.id, nodeId: "paired-node" },
          });
          await awaitResponseFrame("inference");
        } else {
          expect(handleGatewayRequest.mock.calls[0]?.[0]).not.toHaveProperty("signal");
          expect(frames).toHaveLength(1);
          expect(complete(request.payload?.id ?? "")).toBe(true);
        }
      } finally {
        socket.emit("close", 1000, Buffer.alloc(0));
        registry.unregister("paired-node-connection");
        await dispatch;
      }
      expect(socket.listenerCount("close")).toBe(0);
    },
  );
});
