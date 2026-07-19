import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import {
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptor,
} from "./methods/registry.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

const METHOD = "workboard.cards.dispatch";

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("gateway method authorization", () => {
  async function dispatchMethod(params: {
    method: string;
    scopes: string[];
    agentRuntimeIdentity?: AgentRuntimeIdentity;
  }) {
    const handler: GatewayRequestHandler = ({ respond }) => respond(true, { ok: true });
    const methodRegistry = createGatewayMethodRegistry([
      createPluginGatewayMethodDescriptor({
        pluginId: "workboard",
        name: params.method,
        handler,
        scope: "operator.write",
      }),
    ]);
    const respond = vi.fn();

    // Reproduce a request whose attached dispatch registry is newer than the global runtime state.
    setActivePluginRegistry(createEmptyPluginRegistry());
    await handleGatewayRequest({
      req: { type: "req", id: "req-1", method: params.method },
      respond,
      client: {
        connId: "conn-1",
        connect: {
          role: "operator",
          scopes: params.scopes,
          client: { id: "test", version: "1", platform: "test", mode: "test" },
          minProtocol: 1,
          maxProtocol: 1,
        },
        ...(params.agentRuntimeIdentity
          ? { internal: { agentRuntimeIdentity: params.agentRuntimeIdentity } }
          : {}),
      } as Parameters<typeof handleGatewayRequest>[0]["client"],
      isWebchatConnect: () => false,
      context: { logGateway: { warn: vi.fn() } } as unknown as Parameters<
        typeof handleGatewayRequest
      >[0]["context"],
      methodRegistry,
    });
    return respond;
  }

  async function dispatch(scopes: string[]) {
    return await dispatchMethod({ method: METHOD, scopes });
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

  it.each([
    {
      name: "plain",
      identity: {
        kind: "agentRuntime",
        agentId: "ops",
        sessionKey: "agent:ops:main",
        gatewayMethods: ["wake"],
      } satisfies AgentRuntimeIdentity,
      allowedMethod: "wake",
      deniedMethod: "cron.list",
    },
    {
      name: "message",
      identity: {
        kind: "agentRuntime",
        agentId: "ops",
        sessionKey: "agent:ops:main",
        gatewayMethods: ["message.action"],
        messageActionContext: { expiresAtMs: Date.now() + 60_000 },
      } satisfies AgentRuntimeIdentity,
      allowedMethod: "message.action",
      deniedMethod: "send",
    },
    {
      name: "sessions_send",
      identity: {
        kind: "agentRuntime",
        agentId: "ops",
        sessionKey: "agent:ops:main",
        gatewayMethods: ["agent"],
        sessionsSendDelegation: {} as AgentRuntimeIdentity["sessionsSendDelegation"],
      } satisfies AgentRuntimeIdentity,
      allowedMethod: "agent",
      deniedMethod: "wake",
    },
  ])(
    "limits $name runtime identity to its exact signed gateway methods",
    async ({ identity, allowedMethod, deniedMethod }) => {
      const allowed = await dispatchMethod({
        method: allowedMethod,
        scopes: ["operator.admin"],
        agentRuntimeIdentity: identity,
      });
      const denied = await dispatchMethod({
        method: deniedMethod,
        scopes: ["operator.admin"],
        agentRuntimeIdentity: identity,
      });

      expect(allowed).toHaveBeenCalledWith(true, { ok: true });
      expect(denied).toHaveBeenCalledWith(false, undefined, {
        code: "FORBIDDEN",
        message: `agent runtime identity is not authorized for gateway method ${deniedMethod}`,
      });
    },
  );

  it("allows a plain runtime's exact signed method and rejects replay to another method", async () => {
    const identity = {
      kind: "agentRuntime",
      agentId: "ops",
      sessionKey: "agent:ops:main",
      gatewayMethods: ["config.get"],
    } satisfies AgentRuntimeIdentity;
    const allowed = await dispatchMethod({
      method: "config.get",
      scopes: ["operator.admin"],
      agentRuntimeIdentity: identity,
    });
    const denied = await dispatchMethod({
      method: "config.apply",
      scopes: ["operator.admin"],
      agentRuntimeIdentity: identity,
    });

    expect(allowed).toHaveBeenCalledWith(true, { ok: true });
    expect(denied).toHaveBeenCalledWith(false, undefined, {
      code: "FORBIDDEN",
      message: "agent runtime identity is not authorized for gateway method config.apply",
    });
  });
});
