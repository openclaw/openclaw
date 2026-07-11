import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { bindGatewayClientAuthorizationDomain } from "./authorization/client-domain.js";
import type {
  GatewayAuthorizationRuntime,
  GatewayMethodAccessPolicy,
  GatewayRbacDenialReason,
} from "./authorization/contracts.js";
import { getGatewayAuthorizationContext } from "./authorization/request-context.js";
import { testing as controlPlaneRateLimitTesting } from "./control-plane-rate-limit.js";
import { NODE_GATEWAY_METHOD_SCOPE } from "./methods/descriptor.js";
import {
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptor,
} from "./methods/registry.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

const METHOD = "workboard.cards.dispatch";
const PRINCIPAL = {
  issuer: "trusted-proxy",
  subject: "member@example.com",
  kind: "human",
} as const;
const DOMAIN = { id: "domain-1" } as const;
const ACCESS_POLICY: GatewayMethodAccessPolicy = {
  kind: "resource",
  permission: "workboard.card.read",
  resolveResources: () => [{ namespace: "plugin:workboard", type: "card", id: "card-1" }],
};

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("gateway method authorization", () => {
  async function dispatch(scopes: string[]) {
    const handler: GatewayRequestHandler = ({ respond }) => respond(true, { ok: true });
    const methodRegistry = createGatewayMethodRegistry([
      createPluginGatewayMethodDescriptor({
        pluginId: "workboard",
        name: METHOD,
        handler,
        scope: "operator.write",
      }),
    ]);
    const respond = vi.fn();

    // Reproduce a request whose attached dispatch registry is newer than the global runtime state.
    setActivePluginRegistry(createEmptyPluginRegistry());
    await handleGatewayRequest({
      req: { type: "req", id: "req-1", method: METHOD },
      respond,
      client: {
        connId: "conn-1",
        connect: {
          role: "operator",
          scopes,
          client: { id: "test", version: "1", platform: "test", mode: "test" },
          minProtocol: 1,
          maxProtocol: 1,
        },
      } as Parameters<typeof handleGatewayRequest>[0]["client"],
      isWebchatConnect: () => false,
      context: {
        authorization: { mode: "legacy" },
        getRuntimeConfig: () => ({}),
        logGateway: { warn: vi.fn() },
      } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
      methodRegistry,
    });
    return respond;
  }

  it("authorizes from the attached registry used for dispatch", async () => {
    const allowed = await dispatch(["operator.write"]);
    const denied = await dispatch(["operator.read"]);

    expect(allowed).toHaveBeenCalledWith(true, { ok: true });
    expect(denied).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "missing scope: operator.write" }),
    );
  });

  async function dispatchIsolated(params: {
    role?: "operator" | "node";
    scopes?: string[];
    principal?: typeof PRINCIPAL;
    domain?: typeof DOMAIN;
    access?: GatewayMethodAccessPolicy;
    authorization: GatewayAuthorizationRuntime;
    getRuntimeConfig?: () => Record<string, unknown>;
    synthetic?: boolean;
    unavailableMethods?: ReadonlySet<string>;
    controlPlaneWrite?: boolean;
  }) {
    const authorizationContexts: Array<ReturnType<typeof getGatewayAuthorizationContext>> = [];
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => {
      authorizationContexts.push(getGatewayAuthorizationContext());
      respond(true, { ok: true });
    });
    const method = params.role === "node" ? "node.event" : METHOD;
    const descriptor =
      params.role === "node"
        ? {
            name: method,
            handler,
            owner: { kind: "core" as const, area: "test" },
            scope: NODE_GATEWAY_METHOD_SCOPE,
            ...(params.access ? { access: params.access } : {}),
            ...(params.controlPlaneWrite ? { controlPlaneWrite: true } : {}),
          }
        : {
            ...createPluginGatewayMethodDescriptor({
              pluginId: "workboard",
              name: method,
              handler,
              scope: "operator.write",
            }),
            ...(params.access ? { access: params.access } : {}),
            ...(params.controlPlaneWrite ? { controlPlaneWrite: true } : {}),
          };
    const methodRegistry = createGatewayMethodRegistry([descriptor]);
    const respond = vi.fn();
    const client = {
      connId: "conn-isolated",
      connect: {
        role: params.role ?? "operator",
        scopes: params.scopes ?? ["operator.write"],
        client: { id: "test", version: "1", platform: "test", mode: "test" },
        minProtocol: 1,
        maxProtocol: 1,
      },
      ...(params.principal ? { principal: params.principal } : {}),
      ...(params.synthetic ? { internal: { pluginRuntimeOwnerId: "trusted-plugin-owner" } } : {}),
    } as NonNullable<Parameters<typeof handleGatewayRequest>[0]["client"]>;
    if (params.domain) {
      bindGatewayClientAuthorizationDomain(client, params.domain);
    }

    await handleGatewayRequest({
      req: { type: "req", id: "req-isolated", method },
      respond,
      client,
      isWebchatConnect: () => false,
      context: {
        authorization: params.authorization,
        getRuntimeConfig: params.getRuntimeConfig ?? (() => ({})),
        logGateway: { warn: vi.fn() },
        ...(params.unavailableMethods
          ? { unavailableGatewayMethods: params.unavailableMethods }
          : {}),
      } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
      methodRegistry,
    });

    return { authorizationContexts, handler, respond };
  }

  it("does not call an unclassified handler in isolated mode", async () => {
    const authorize = vi.fn();
    const { handler, respond } = await dispatchIsolated({
      authorization: { mode: "isolated", authorize },
      principal: PRINCIPAL,
      domain: DOMAIN,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "resource not found" }),
    );
  });

  it("does not treat synthetic admin scopes or plugin ownership as an isolated principal", async () => {
    const authorize = vi.fn();
    const { handler, respond } = await dispatchIsolated({
      authorization: { mode: "isolated", authorize },
      access: ACCESS_POLICY,
      scopes: ["operator.admin"],
      synthetic: true,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "resource not found" }),
    );
  });

  it("denies before disclosing startup availability", async () => {
    const { respond } = await dispatchIsolated({
      authorization: { mode: "isolated", authorize: vi.fn() },
      principal: PRINCIPAL,
      domain: DOMAIN,
      unavailableMethods: new Set([METHOD]),
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST", message: "resource not found" }),
    );
    expect(JSON.stringify(respond.mock.calls)).not.toContain("UNAVAILABLE");
  });

  it("does not consume control-plane budget or acquire root admission for an isolated denial", async () => {
    controlPlaneRateLimitTesting.resetControlPlaneRateLimitState();
    try {
      const denied = await dispatchIsolated({
        authorization: { mode: "isolated", authorize: vi.fn() },
        principal: PRINCIPAL,
        domain: DOMAIN,
        controlPlaneWrite: true,
      });

      expect(denied.handler).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(0);

      for (let index = 0; index < 3; index += 1) {
        const allowed = await dispatchIsolated({
          authorization: { mode: "legacy" },
          controlPlaneWrite: true,
        });
        expect(allowed.handler).toHaveBeenCalledOnce();
      }
    } finally {
      controlPlaneRateLimitTesting.resetControlPlaneRateLimitState();
    }
  });

  it.each([
    { role: "operator" as const, scopes: ["operator.admin"] },
    { role: "node" as const, scopes: [] },
  ])(
    "does not let $role scope handling bypass isolated authorization",
    async ({ role, scopes }) => {
      const authorize = vi.fn(async () => ({ allowed: false, reason: "forbidden" }) as const);
      const { handler } = await dispatchIsolated({
        role,
        scopes,
        principal: PRINCIPAL,
        domain: DOMAIN,
        access: ACCESS_POLICY,
        authorization: { mode: "isolated", authorize },
      });

      expect(handler).not.toHaveBeenCalled();
      expect(authorize).toHaveBeenCalledOnce();
    },
  );

  it("uses the access policy from the attached dispatch registry", async () => {
    const authorize = vi.fn(async () => ({
      allowed: true as const,
      principalId: "principal-1",
      domain: { id: "domain-1" },
    }));
    const { authorizationContexts, handler, respond } = await dispatchIsolated({
      principal: PRINCIPAL,
      domain: DOMAIN,
      access: ACCESS_POLICY,
      authorization: { mode: "isolated", authorize },
    });

    expect(authorize).toHaveBeenCalledWith({
      principal: PRINCIPAL,
      domain: DOMAIN,
      method: METHOD,
      permission: "workboard.card.read",
      resources: [{ namespace: "plugin:workboard", type: "card", id: "card-1" }],
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(authorizationContexts).toEqual([{ principalId: "principal-1", domain: DOMAIN }]);
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("preserves unclassified method dispatch in explicit legacy mode", async () => {
    const getRuntimeConfig = vi.fn(() => {
      throw new Error("legacy dispatch must not resolve config");
    });
    const { handler, respond } = await dispatchIsolated({
      authorization: { mode: "legacy" },
      getRuntimeConfig,
    });

    expect(getRuntimeConfig).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("redacts sensitive isolated denial reasons to one wire response", async () => {
    const responses: unknown[] = [];
    for (const reason of [
      "unbound-resource",
      "cross-domain",
      "forbidden",
      "indeterminate",
    ] satisfies GatewayRbacDenialReason[]) {
      const { respond } = await dispatchIsolated({
        principal: PRINCIPAL,
        domain: DOMAIN,
        access: ACCESS_POLICY,
        authorization: {
          mode: "isolated",
          authorize: async () => ({ allowed: false, reason }),
        },
      });
      responses.push(respond.mock.calls[0]);
    }

    expect(responses).toHaveLength(4);
    expect(
      responses.every((response) => JSON.stringify(response) === JSON.stringify(responses[0])),
    ).toBe(true);
    expect(JSON.stringify(responses[0])).not.toContain("cross-domain");
    expect(JSON.stringify(responses[0])).not.toContain("forbidden");
  });
});
