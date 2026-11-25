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
import { sendAuthorizationRequest as send } from "./server-methods.authorization.test-support.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

const METHOD = "workboard.cards.dispatch";

function pluginRegistry(name: string, handler: GatewayRequestHandler, pluginId: string) {
  const registry = createEmptyPluginRegistry();
  registry.gatewayMethodDescriptors.push(
    createPluginGatewayMethodDescriptor({ pluginId, name, handler, scope: WRITE_SCOPE }),
  );
  return registry;
}

afterEach(resetPluginRuntimeStateForTest);

describe("gateway method authorization", () => {
  it.each([
    { sessionKey: "agent:main:demo", agentId: "research", message: "does not match" },
    { sessionKey: "agent:main", message: "malformed session key" },
    { sessionKey: "demo", message: "Pass agentId" },
  ])(
    "returns INVALID_REQUEST for an invalid chat target $sessionKey",
    async ({ message, ...target }) => {
      const handler = vi.fn<GatewayRequestHandler>();
      const respond = await send(
        "chat.send",
        { ...target, message: "hello", idempotencyKey: "invalid-chat-target" },
        {
          scopes: ["operator.admin"],
          context: {
            getRuntimeConfig: () => ({
              agents: { ownership: "explicit", entries: { main: {}, research: {} } },
            }),
          },
          extraHandlers: { "chat.send": handler },
        },
      );
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
    const handler: GatewayRequestHandler = ({ respond }) => {
      expect(requireActivePluginRegistry()).toBe(attachedPluginRegistry);
      respond(true, { ok: true });
    };
    const attachedPluginRegistry = pluginRegistry(METHOD, handler, "workboard");
    const methodRegistry = createGatewayMethodRegistry(
      attachedPluginRegistry.gatewayMethodDescriptors,
      attachedPluginRegistry,
    );

    // Reproduce a request whose attached dispatch registry is newer than the global runtime state.
    setActivePluginRegistry(createEmptyPluginRegistry());
    return send(METHOD, undefined, {
      scopes,
      methodRegistry,
    });
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
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) =>
      respond(true, { ok: true, ts: 42 }),
    );
    const activeRegistry = pluginRegistry("demo.ping", handler, "demo");
    activeRegistry.gatewayHandlers["demo.ping"] = handler;
    setActivePluginRegistry(activeRegistry);

    const respond = await send(
      "demo.ping",
      { hello: "world" },
      {
        methodRegistry: createGatewayMethodRegistry([]),
      },
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(true, { ok: true, ts: 42 });
  });

  it("rejects every node RPC when its connection no longer owns the pairing generation", async () => {
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
    const isConnectionCurrentPairingState = vi.fn().mockResolvedValue(false);

    const respond = await send(
      "node.event",
      { event: "test" },
      {
        connId: "conn-node-stale",
        scopes: [],
        connect: {
          role: "node",
          device: {
            id: "node-stale",
            publicKey: "public-key",
            signature: "signature",
            signedAt: 1,
            nonce: "nonce",
          },
          client: { id: "node-host", version: "1", platform: "test", mode: "node" },
        },
        context: {
          nodeRegistry: { isConnectionCurrentPairingState },
        },
        extraHandlers: { "node.event": handler },
      },
    );

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
