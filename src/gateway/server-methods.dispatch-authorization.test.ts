import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  requireActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginGatewayMethodDescriptor } from "./methods/descriptor.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { WRITE_SCOPE } from "./operator-scopes.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

function requestDefaults(
  scopes: string[] = [WRITE_SCOPE],
): Pick<Parameters<typeof handleGatewayRequest>[0], "client" | "isWebchatConnect" | "context"> {
  return {
    client: {
      connId: "conn-proof",
      connect: {
        role: "operator",
        scopes,
        client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
        minProtocol: 1,
        maxProtocol: 1,
      },
    },
    isWebchatConnect: () => false,
    context: {
      logGateway: { warn: vi.fn() },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
  };
}

const METHOD = "workboard.cards.dispatch";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("gateway method authorization", () => {
  it.each([
    { sessionKey: "agent:main:demo", agentId: "research", message: "does not match" },
    { sessionKey: "agent:main", message: "malformed session key" },
    { sessionKey: "demo", message: "Pass agentId" },
  ])(
    "returns INVALID_REQUEST for an invalid chat target $sessionKey",
    async ({ message, ...target }) => {
      const defaults = requestDefaults(["operator.admin"]);
      const handler = vi.fn<GatewayRequestHandler>();
      const respond = vi.fn();
      await handleGatewayRequest({
        ...defaults,
        context: {
          ...defaults.context,
          getRuntimeConfig: () => ({
            agents: { ownership: "explicit", entries: { main: {}, research: {} } },
          }),
        },
        req: {
          type: "req",
          id: "invalid-chat-target",
          method: "chat.send",
          params: { ...target, message: "hello", idempotencyKey: "invalid-chat-target" },
        },
        respond,
        extraHandlers: { "chat.send": handler },
      });
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: expect.stringContaining(message),
        }),
      );
      expect(handler).not.toHaveBeenCalled();
    },
  );

  async function dispatch(scopes: string[]) {
    const attachedPluginRegistry = createEmptyPluginRegistry();
    const handler: GatewayRequestHandler = ({ respond }) => {
      expect(requireActivePluginRegistry()).toBe(attachedPluginRegistry);
      respond(true, { ok: true });
    };
    const methodRegistry = createGatewayMethodRegistry(
      [
        createPluginGatewayMethodDescriptor({
          pluginId: "workboard",
          name: METHOD,
          handler,
          scope: "operator.write",
        }),
      ],
      attachedPluginRegistry,
    );
    const respond = vi.fn();

    // Reproduce a request whose attached dispatch registry is newer than the global runtime state.
    setActivePluginRegistry(createEmptyPluginRegistry());
    await handleGatewayRequest({
      req: { type: "req", id: "req-1", method: METHOD },
      respond,
      ...requestDefaults(scopes),
      methodRegistry,
    });
    return respond;
  }

  it("authorizes from the attached registry used for dispatch", async () => {
    const allowed = await dispatch(["operator.write"]);
    const denied = await dispatch(["operator.read"]);

    expect(allowed).toHaveBeenCalledWith(true, { ok: true });
    expect(denied).toHaveBeenCalledWith(false, undefined, {
      code: "FORBIDDEN",
      message: "missing scope: operator.write",
      details: {
        code: "MISSING_SCOPE",
        missingScope: "operator.write",
        requiredScopes: ["operator.write"],
      },
    });
  });

  it("dispatches plugin methods registered after the startup method registry snapshot", async () => {
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => {
      respond(true, { ok: true, ts: 42 });
    });
    const activeRegistry = createEmptyPluginRegistry();
    activeRegistry.gatewayHandlers["demo.ping"] = handler;
    activeRegistry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: "demo",
        name: "demo.ping",
        handler,
        scope: WRITE_SCOPE,
      }),
    );
    setActivePluginRegistry(activeRegistry);

    const staleStartupRegistry = createGatewayMethodRegistry([]);
    const respond = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "proof-94127",
        method: "demo.ping",
        params: { hello: "world" },
      },
      respond,
      ...requestDefaults(),
      methodRegistry: staleStartupRegistry,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(true, { ok: true, ts: 42 });
  });

  it("rejects every node RPC when its connection no longer owns the pairing generation", async () => {
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
    const respond = vi.fn();
    const isConnectionCurrentPairingState = vi.fn().mockResolvedValue(false);

    await handleGatewayRequest({
      req: { type: "req", id: "req-node-stale", method: "node.event", params: { event: "test" } },
      respond,
      client: {
        connId: "conn-node-stale",
        connect: {
          role: "node",
          scopes: [],
          device: {
            id: "node-stale",
            publicKey: "public-key",
            signature: "signature",
            signedAt: 1,
            nonce: "nonce",
          },
          client: { id: "node-host", version: "1", platform: "test", mode: "node" },
          minProtocol: 1,
          maxProtocol: 1,
        },
      } as Parameters<typeof handleGatewayRequest>[0]["client"],
      isWebchatConnect: () => false,
      context: {
        logGateway: { warn: vi.fn() },
        nodeRegistry: { isConnectionCurrentPairingState },
      } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
      extraHandlers: { "node.event": handler },
    });

    expect(isConnectionCurrentPairingState).toHaveBeenCalledWith("conn-node-stale");
    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        details: { code: "PAIRING_CHANGED" },
      }),
    );
  });
});
