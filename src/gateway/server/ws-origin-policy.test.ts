import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureGatewayAuthPolicy, isGatewayAuthGrantCurrent } from "../auth-policy.js";
import type { OperatorScope } from "../operator-scopes.js";
import { createRemoteControlUiIngressTestContext } from "../remote-control-ui.test-support.js";
import { GatewayClientRegistry } from "./client-registry.js";
import { disconnectDisallowedGatewayPolicyClients } from "./ws-origin-policy.js";
import { onGatewayPolicyClientInvalidated } from "./ws-policy-close.js";
import type { GatewayWsClient } from "./ws-types.js";

type Principal = Parameters<typeof captureGatewayAuthPolicy>[1];
function policyClient(config: OpenClawConfig, principal: Principal) {
  return {
    authPolicy: captureGatewayAuthPolicy(config, principal),
    invalidated: false,
    sourceInvalidated: false,
    socket: { close: vi.fn() },
  };
}
function browserClient(origin: string, requestHost = "gateway.example.test") {
  return {
    browserOrigin: { origin, requestHost, isLocalClient: false },
    socket: { close: vi.fn() },
    connId: origin,
    connect: { client: { id: "openclaw-control-ui" }, role: "operator" },
    invalidated: false,
    invalidatedReason: undefined as string | undefined,
  };
}
function identityConfig(identityScopes: Record<string, OperatorScope[]>): OpenClawConfig {
  return { gateway: { auth: { identityScopes } } };
}

describe("committed browser origin policy", () => {
  it("rechecks contextual ingress even when the config and policy objects are unchanged", () => {
    let current = true;
    const ingress = createRemoteControlUiIngressTestContext({
      assertCurrent() {
        if (!current) {
          throw new Error("Ingress revoked");
        }
      },
    });
    const config: OpenClawConfig = {};
    const policy = captureGatewayAuthPolicy(config, {
      role: "operator",
      browserOrigin: { origin: ingress.publicOrigin, remoteControlUiIngress: ingress },
    });
    expect(isGatewayAuthGrantCurrent(policy, config)).toBe(true);
    current = false;
    expect(isGatewayAuthGrantCurrent(policy, config)).toBe(false);
  });

  it.each([
    ["allowedOrigins", false],
    ["publicOrigin", false],
    ["host fallback", false],
    ["host fallback", true],
  ] as const)("revokes %s admission with disconnected=%s", (policy, disconnected) => {
    const origin = "https://revoked.example.test";
    const retained = browserClient("https://retained.example.test");
    const initial: OpenClawConfig = {
      gateway: {
        publicOrigin: policy === "publicOrigin" ? origin : undefined,
        controlUi: {
          allowedOrigins: [
            retained.browserOrigin.origin,
            ...(policy === "allowedOrigins" ? [origin] : []),
          ],
          dangerouslyAllowHostHeaderOriginFallback: policy === "host fallback",
        },
      },
    };
    const browser = browserClient(origin, "revoked.example.test");
    const client = {
      ...browser,
      ...policyClient(initial, { role: "operator", browserOrigin: browser.browserOrigin }),
    };
    const backend = {
      connId: "backend",
      connect: { client: { id: "gateway-client" }, role: "operator" },
      socket: { close: vi.fn() },
    };
    const registry = new GatewayClientRegistry([client, retained, backend] as never);
    onTestFinished(registry.retainRequest(client as unknown as GatewayWsClient));
    if (disconnected) {
      registry.delete(client as unknown as GatewayWsClient);
    }
    const onRevoked = vi.fn();
    onTestFinished(onGatewayPolicyClientInvalidated(client, onRevoked));
    const clients = registry.authorityClients;
    disconnectDisallowedGatewayPolicyClients(clients, initial);
    expect(client.socket.close).not.toHaveBeenCalled();
    if (!disconnected) {
      const fenced = structuredClone(initial);
      fenced.gateway!.trustedProxies = ["192.0.2.10"];
      disconnectDisallowedGatewayPolicyClients(clients, fenced);
      expect(client.socket.close).toHaveBeenCalledWith(4001, "gateway policy changed");
      expect(client.sourceInvalidated).toBe(false);
      expect(onRevoked).not.toHaveBeenCalled();
      expect(isGatewayAuthGrantCurrent(client.authPolicy, fenced)).toBe(true);
    }
    const removed: OpenClawConfig = {
      gateway: { controlUi: { allowedOrigins: [retained.browserOrigin.origin] } },
    };
    expect(isGatewayAuthGrantCurrent(client.authPolicy, removed)).toBe(false);
    disconnectDisallowedGatewayPolicyClients(clients, removed);
    expect(client).toMatchObject({
      invalidated: true,
      sourceInvalidated: true,
      invalidatedReason: "origin-policy-changed",
    });
    expect(onRevoked).toHaveBeenCalledOnce();
    expect(client.socket.close).toHaveBeenLastCalledWith(1008, "origin not allowed");
    expect(client.socket.close).toHaveBeenCalledTimes(disconnected ? 1 : 2);
    expect(retained.socket.close).not.toHaveBeenCalled();
    expect(backend.socket.close).not.toHaveBeenCalled();
  });

  it("keeps origin grants separate for the same authenticated identity", () => {
    const origins = ["https://retained.example.test", "https://removed.example.test"];
    const initial: OpenClawConfig = { gateway: { controlUi: { allowedOrigins: origins } } };
    const clients = origins.map((origin) => {
      const client = browserClient(origin);
      return {
        ...client,
        authPolicy: captureGatewayAuthPolicy(initial, {
          role: "operator",
          verifiedIdentity: "same@example.test",
          browserOrigin: client.browserOrigin,
        }),
      };
    });
    const next: OpenClawConfig = { gateway: { controlUi: { allowedOrigins: [origins[0]!] } } };
    expect(clients.map((client) => isGatewayAuthGrantCurrent(client.authPolicy, next))).toEqual([
      true,
      false,
    ]);
    disconnectDisallowedGatewayPolicyClients(clients, next);
    expect(clients[0]!.socket.close).not.toHaveBeenCalled();
    expect(clients[1]!.socket.close).toHaveBeenCalledWith(1008, "origin not allowed");
  });
});

describe("committed authentication policy", () => {
  const identity = "retained@example.test";
  const principal = { role: "operator", verifiedIdentity: identity };
  const grants = {
    "Retained@example.test": ["operator.write", "operator.read"],
    "other@example.test": ["operator.admin"],
  } satisfies Record<string, OperatorScope[]>;
  const authConfig = (
    auth: NonNullable<NonNullable<OpenClawConfig["gateway"]>["auth"]>,
  ): OpenClawConfig => ({ gateway: { auth } });
  const proxy = { userHeader: "x-user", allowUsers: [identity] };
  function check(
    initial: OpenClawConfig,
    next: OpenClawConfig,
    source: Principal,
    revoked = false,
  ) {
    const client = policyClient(initial, source);
    const onRevoked = vi.fn();
    onTestFinished(onGatewayPolicyClientInvalidated(client, onRevoked));
    expect(isGatewayAuthGrantCurrent(client.authPolicy, initial)).toBe(true);
    disconnectDisallowedGatewayPolicyClients([client], next);
    expect(client).toMatchObject({ invalidated: revoked, sourceInvalidated: revoked });
    expect(onRevoked).toHaveBeenCalledTimes(revoked ? 1 : 0);
    expect(client.socket.close.mock.calls).toEqual(
      revoked ? [[4001, "gateway policy changed"]] : [],
    );
  }

  it.each([false, true])("honors startup auth mode override %s", (override) => {
    check(
      authConfig({ mode: "none" }),
      authConfig({ mode: "token" }),
      { role: "operator", authMethod: "none", authModeOverride: override ? "none" : undefined },
      !override,
    );
  });
  it.each([
    { role: "operator", verifiedIdentity: undefined },
    { role: "node", verifiedIdentity: "other@example.test" },
  ])("preserves $role without identity-derived scopes", (source) => {
    check({}, identityConfig({ "other@example.test": ["operator.admin"] }), source);
  });
  it.each<[string, Record<string, OperatorScope[]>, boolean]>([
    ["another identity added", { ...grants, "new@example.test": ["operator.admin"] }, false],
    [
      "same scopes reordered",
      { ...grants, "Retained@example.test": ["operator.read", "operator.write", "operator.read"] },
      false,
    ],
    ["identity removed", { "other@example.test": grants["other@example.test"] }, true],
    ["identity downgraded", { ...grants, "Retained@example.test": ["operator.read"] }, true],
    ["exact match shadows normalized grant", { ...grants, [identity]: [] }, true],
  ])("reconciles %s", (_name, scopes, revoked) => {
    check(identityConfig(grants), identityConfig(scopes), principal, revoked);
  });
  it.each(["requiredHeaders", "allowUsers"] as const)("ignores reordered proxy %s", (field) => {
    const trustedProxy = {
      ...proxy,
      requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
      allowUsers: ["reader@example.test", "writer@example.test"],
    };
    check(
      authConfig({ trustedProxy }),
      authConfig({ trustedProxy: { ...trustedProxy, [field]: trustedProxy[field].toReversed() } }),
      null,
    );
  });
  it.each([
    ["operator.admin", "operator.read"],
    ["operator.write", "operator.read", "operator.talk"],
    ["operator.read", "operator.sessions.read"],
    ["operator.sessions.write", "operator.sessions.read"],
  ] satisfies OperatorScope[][])("accepts redundant implied scopes %j", (...scopes) => {
    check(
      identityConfig({ [identity]: scopes }),
      identityConfig({ [identity]: [scopes[0]!] }),
      principal,
    );
  });
  it.each([
    "allowUsers",
    "proxy removed",
    "proxy disabled",
    "tailscale disabled",
    "tailscale default removed",
  ])("revokes when %s admission ends", (change) => {
    const tailscale = change.startsWith("tailscale");
    const initial: OpenClawConfig = {
      gateway: {
        tailscale: { mode: "serve" },
        auth: {
          mode: tailscale ? "token" : "trusted-proxy",
          allowTailscale: change === "tailscale default removed" ? undefined : true,
          trustedProxy: proxy,
        },
      },
    };
    const next = structuredClone(initial);
    const auth = next.gateway!.auth!;
    if (change === "allowUsers") {
      auth.trustedProxy!.allowUsers = ["other@example.test"];
    } else if (change === "proxy removed") {
      delete auth.trustedProxy;
    } else if (change === "proxy disabled") {
      auth.mode = "token";
    } else if (change === "tailscale default removed") {
      next.gateway!.tailscale!.mode = "off";
    } else {
      auth.allowTailscale = false;
    }
    check(
      initial,
      next,
      { ...principal, authMethod: tailscale ? "tailscale" : "trusted-proxy" },
      true,
    );
  });

  it("preserves serialized grants across equivalent scope edits without accepting malformed or revoked grants", () => {
    const policy = {
      generation: "",
      grantGeneration:
        '{"browserOriginAllowed":undefined,"fallbackCredentialGeneration":undefined,"grant":["operator.read","operator.write"],"methodEnabled":true,"proxyUserAllowed":true}',
      role: "operator",
      authMethod: "trusted-proxy" as const,
      verifiedIdentity: identity,
    };
    const next: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "trusted-proxy",
          trustedProxy: { userHeader: "x-user", allowUsers: [identity] },
          identityScopes: { [identity]: ["operator.write"] },
        },
      },
    };
    expect(isGatewayAuthGrantCurrent(policy, next)).toBe(true);
    for (const grantGeneration of [
      "invalid-fingerprint",
      policy.grantGeneration.replace('["operator.read","operator.write"]', "[1]"),
      policy.grantGeneration.replace('"methodEnabled":true', '"methodEnabled":false'),
    ]) {
      expect(isGatewayAuthGrantCurrent({ ...policy, grantGeneration }, next)).toBe(false);
    }
    const revoked = structuredClone(next);
    revoked.gateway!.auth!.identityScopes![identity] = ["operator.read"];
    expect(isGatewayAuthGrantCurrent(policy, revoked)).toBe(false);
  });

  it.each(["retained@example.test", "other@example.test"])(
    "latches an added then removed grant only for its source: %s",
    (changedIdentity) => {
      const client = {
        ...policyClient({}, { role: "operator", verifiedIdentity: identity }),
        authenticatedUserId: identity,
      };
      disconnectDisallowedGatewayPolicyClients(
        [client],
        identityConfig({ [changedIdentity]: ["operator.admin"] }),
      );
      disconnectDisallowedGatewayPolicyClients([client], {});
      expect(client.invalidated).toBe(changedIdentity === identity);
    },
  );
});
