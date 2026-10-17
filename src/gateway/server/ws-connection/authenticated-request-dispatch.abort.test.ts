/** Verifies transport disconnect cancellation stays scoped to request-owned work. */
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
import type { GatewayWsClient } from "../ws-types.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";

const handleGatewayRequest = vi.hoisted(() => vi.fn());

vi.mock("./authenticated-request-dispatch.server-methods.runtime.js", () => ({
  handleGatewayRequest,
}));

const activeRegistries = new Set<NodeRegistry>();
const controlUi = { id: GATEWAY_CLIENT_IDS.CONTROL_UI, mode: GATEWAY_CLIENT_MODES.UI };

afterEach(() => {
  for (const registry of activeRegistries) {
    registry.unregister("paired-node-connection");
  }
  activeRegistries.clear();
  handleGatewayRequest.mockReset();
});

function createPairedNode() {
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
      usesSharedGatewayAuth: false,
      socket: {
        readyState: WebSocket.OPEN,
        send(frame: string | Buffer) {
          frames.push(frame.toString());
          frameArrived.resolve();
          frameArrived = createDeferredCore();
        },
      },
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: {
          id: GATEWAY_CLIENT_IDS.NODE_HOST,
          version: "1.0.0",
          platform: "linux",
          mode: "node",
        },
        device: {
          id: "paired-node",
          publicKey: "public-key",
          signature: "signature",
          signedAt: 1,
          nonce: "nonce",
        },
        caps: ["local-inference"],
        commands: ["ollama.chat"],
      },
    } as GatewayWsClient,
    { pairingIdentity: "paired-node-identity" },
  );
  const invoke = async (options: GatewayRequestOptions, withError = false) => {
    const result = await registry.invoke({
      nodeId: "paired-node",
      command: "ollama.chat",
      timeoutMs: 10_000,
      signal: options.signal,
    });
    if (!withError) {
      options.respond(result.ok, result.payload);
      return;
    }
    options.respond(
      result.ok,
      result.payload,
      result.error
        ? {
            code: result.error.code ?? "UNAVAILABLE",
            message: result.error.message ?? "node invocation failed",
          }
        : undefined,
    );
  };
  return { registry, frames, waitForFrameCount, invoke };
}

function nodeRequest(id: string) {
  return {
    type: "req",
    id,
    method: "node.invoke",
    params: {
      nodeId: "paired-node",
      command: "ollama.chat",
      idempotencyKey: id,
    },
  };
}

function createDispatcher(
  socket: EventEmitter,
  clientInfo: Pick<GatewayWsClient["connect"]["client"], "id" | "mode"> = {
    id: GATEWAY_CLIENT_IDS.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
  },
) {
  const client = createOperatorWsClient({
    connId: "operator-connection",
    socket,
    clientInfo,
    scopes: ["operator.write"],
  });
  const harness = createDispatchTestHarness({ connId: client.connId });
  return { client, ...harness };
}

describe("authenticated WebSocket request cancellation", () => {
  it.each([
    { method: "plugins.reload", params: { plugins: [{ pluginId: "demo" }] }, cancelled: false },
    {
      method: "plugins.reload",
      params: { plugins: [{ pluginId: "demo" }], waitForDrain: true },
      cancelled: true,
    },
    { method: "sessions.usage", params: { range: "all" }, cancelled: true },
  ])(
    "binds request-owned $method work to disconnect (cancelled=$cancelled)",
    async ({ method, params, cancelled }) => {
      const socket = new EventEmitter();
      const { client, dispatcher } = createDispatcher(socket, controlUi);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let signal: AbortSignal | undefined;
      handleGatewayRequest.mockImplementation(async (options: GatewayRequestOptions) => {
        signal = options.signal;
        entered.resolve();
        await release.promise;
      });
      const dispatch = dispatcher.dispatch(
        { type: "req", id: "disconnect-work", method, params },
        client,
      );
      try {
        await entered.promise;
        socket.emit("close", 1000, Buffer.alloc(0));
        if (cancelled) {
          expect(signal?.aborted).toBe(true);
        } else {
          expect(signal).toBeUndefined();
        }
      } finally {
        release.resolve();
        await dispatch;
      }
      expect(socket.listenerCount("close")).toBe(0);
    },
  );

  it("cancels only access-bound work after a grant ends, including after ordinary disconnect", async () => {
    const { registry, frames, waitForFrameCount, invoke } = createPairedNode();
    const guestSocket = new EventEmitter();
    const guest = createDispatcher(guestSocket, controlUi);
    const staff = createDispatcher(new EventEmitter(), controlUi);
    const profile = {
      profileId: "same-person",
      displayName: null,
      avatarRevision: "1",
      hasAvatar: false,
      updatedAt: 1,
    };
    guest.client.authenticatedUserProfile = profile;
    staff.client.authenticatedUserProfile = profile;
    const grant = new AbortController();
    guest.client.internal = {
      operatorAccessAuthority: {
        signal: grant.signal,
        assertCurrent: () => grant.signal.throwIfAborted(),
      },
    };
    handleGatewayRequest.mockImplementation((options: GatewayRequestOptions) => invoke(options));
    const request = (id: string) => ({
      type: "req",
      id,
      method: "test.access-lifetime",
      params: { sessionKey: "agent:main:shared" },
    });
    const guestDispatch = guest.dispatcher.dispatch(request("guest"), guest.client);
    await waitForFrameCount(1);
    const staffDispatch = staff.dispatcher.dispatch(request("staff"), staff.client);
    try {
      await waitForFrameCount(2);
      guestSocket.emit("close", 1006, Buffer.alloc(0));
      expect(frames).toHaveLength(2);
      grant.abort(new Error("Grant ended"));
      await waitForFrameCount(3);
      const guestRequest = JSON.parse(frames[0] ?? "{}") as { payload: { id: string } };
      const staffRequest = JSON.parse(frames[1] ?? "{}") as { payload: { id: string } };
      expect(JSON.parse(frames[2] ?? "{}")).toMatchObject({
        event: "node.invoke.cancel",
        payload: { invokeId: guestRequest.payload.id },
      });
      expect(
        registry.handleInvokeResult({
          id: staffRequest.payload.id,
          nodeId: "paired-node",
          connId: "paired-node-connection",
          ok: true,
        }),
      ).toBe(true);
      await staff.awaitResponseFrame("staff");
      expect(staff.close).not.toHaveBeenCalled();
    } finally {
      registry.unregister("paired-node-connection");
      await Promise.all([guestDispatch, staffDispatch]);
    }
  });

  it("forwards CLI socket closure to the actual first-party node cancel event", async () => {
    const socket = new EventEmitter();
    const { frames, waitForFrameCount, invoke } = createPairedNode();
    const { awaitResponseFrame, client, dispatcher } = createDispatcher(socket);
    handleGatewayRequest.mockImplementation((options: GatewayRequestOptions) =>
      invoke(options, true),
    );
    const dispatch = dispatcher.dispatch(nodeRequest("paired-node-cli-inference"), client);
    try {
      await waitForFrameCount(1);
      expect(socket.listenerCount("close")).toBe(1);
      socket.emit("close", 1000, Buffer.alloc(0));
      await waitForFrameCount(2);
      const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
      expect(JSON.parse(frames[1] ?? "{}")).toMatchObject({
        event: "node.invoke.cancel",
        payload: { invokeId: request.payload?.id, nodeId: "paired-node" },
      });
      await awaitResponseFrame("paired-node-cli-inference");
    } finally {
      socket.emit("close", 1000, Buffer.alloc(0));
      await dispatch;
    }
    expect(socket.listenerCount("close")).toBe(0);
  });

  it("does not cancel an authenticated control UI node invocation on socket close", async () => {
    const socket = new EventEmitter();
    const { registry, frames, waitForFrameCount, invoke } = createPairedNode();
    const { client, dispatcher } = createDispatcher(socket, controlUi);
    handleGatewayRequest.mockImplementation((options: GatewayRequestOptions) => invoke(options));
    const dispatch = dispatcher.dispatch(nodeRequest("paired-node-ordinary-inference"), client);
    try {
      await waitForFrameCount(1);
      expect(handleGatewayRequest.mock.calls[0]?.[0]).not.toHaveProperty("signal");
      expect(socket.listenerCount("close")).toBe(0);
      socket.emit("close", 1000, Buffer.alloc(0));
      expect(frames).toHaveLength(1);
      const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
      expect(
        registry.handleInvokeResult({
          id: request.payload?.id ?? "",
          nodeId: "paired-node",
          connId: "paired-node-connection",
          ok: true,
        }),
      ).toBe(true);
    } finally {
      registry.unregister("paired-node-connection");
      await dispatch;
    }
  });
});
