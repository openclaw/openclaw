import { expect, it, onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureGatewayAuthPolicy as capture,
  isGatewayAuthGrantCurrent as grantCurrent,
} from "../auth-policy.js";
import type { OperatorScope } from "../operator-scopes.js";
import { GatewayClientRegistry } from "./client-registry.js";
import { disconnectDisallowedGatewayPolicyClients as reconcile } from "./ws-origin-policy.js";
import {
  holdGatewayPolicyResponse as holdResponse,
  onGatewayPolicyClientInvalidated as onInvalidated,
  registerGatewayPolicyResponse as registerResponse,
} from "./ws-policy-close.js";
import type { GatewayWsClient } from "./ws-types.js";

function policyClient(initial: OpenClawConfig, principal: Parameters<typeof capture>[1]) {
  return {
    authPolicy: capture(initial, principal),
    invalidated: false,
    sourceInvalidated: false,
    socket: { close: vi.fn() },
  };
}

function browserOrigin(origin: string, requestHost = new URL(origin).host) {
  return { origin, requestHost, isLocalClient: false };
}

function watchRevocation(client: Parameters<typeof onInvalidated>[0]) {
  const revoked = vi.fn();
  onTestFinished(onInvalidated(client, revoked));
  return revoked;
}

function origins(allowedOrigins: string[], fallback = false): OpenClawConfig {
  return {
    gateway: { controlUi: { allowedOrigins, dangerouslyAllowHostHeaderOriginFallback: fallback } },
  };
}

const retainedOrigin = "https://retained.example.test";
const revokedOrigin = "https://revoked.example.test";

it.each([
  { policy: "allowedOrigins", fence: true },
  { policy: "publicOrigin", fence: true },
  { policy: "host fallback", fence: true },
  { policy: "allowedOrigins", fence: false },
  { policy: "host fallback", fence: false },
])("selectively revokes $policy grants (transport fenced=$fence)", ({ policy, fence }) => {
  const initial = origins(
    [retainedOrigin, ...(policy === "allowedOrigins" ? [revokedOrigin] : [])],
    policy === "host fallback",
  );
  if (policy === "publicOrigin") {
    initial.gateway!.publicOrigin = revokedOrigin;
  }
  const browser = (url: string) => {
    const origin = browserOrigin(url);
    const client = {
      ...policyClient(initial, {
        role: "operator",
        verifiedIdentity: "same@example.test",
        browserOrigin: origin,
      }),
      connId: url,
      connect: { role: "operator", client: { id: "openclaw-control-ui" } },
      browserOrigin: origin,
      invalidatedReason: undefined as string | undefined,
    };
    return { client, onRevoked: watchRevocation(client) };
  };
  const { client: revoked, onRevoked } = browser(revokedOrigin);
  const retained = browser(retainedOrigin);
  const backend = {
    connId: "backend",
    connect: { role: "operator", client: { id: "gateway-client" } },
    socket: { close: vi.fn() },
  };
  const registry = new GatewayClientRegistry([revoked, retained.client, backend] as never);
  onTestFinished(registry.retainRequest(revoked as unknown as GatewayWsClient));
  if (policy === "host fallback" && !fence) {
    registry.delete(revoked as unknown as GatewayWsClient);
  }
  const clients = registry.authorityClients;
  reconcile(clients, initial);
  expect(revoked.socket.close).not.toHaveBeenCalled();
  const fenced = structuredClone(initial);
  if (fence) {
    fenced.gateway!.trustedProxies = ["192.0.2.10"];
    reconcile(clients, fenced);
    expect(revoked.socket.close).toHaveBeenCalledWith(4001, "gateway policy changed");
    expect(revoked.sourceInvalidated).toBe(false);
    expect(onRevoked).not.toHaveBeenCalled();
    expect(grantCurrent(revoked.authPolicy, fenced)).toBe(true);
    revoked.socket.close.mockClear();
  }
  const removed = structuredClone(fenced);
  delete removed.gateway!.publicOrigin;
  removed.gateway!.controlUi = { allowedOrigins: [retainedOrigin] };
  expect(
    [revoked, retained.client].map((client) => grantCurrent(client.authPolicy, removed)),
  ).toEqual([false, true]);
  reconcile(clients, removed);
  expect(revoked).toMatchObject({
    invalidated: true,
    sourceInvalidated: true,
    invalidatedReason: fence ? "gateway-policy-changed" : "origin-policy-changed",
  });
  expect(onRevoked).toHaveBeenCalledOnce();
  expect(revoked.socket.close).toHaveBeenCalledExactlyOnceWith(1008, "origin not allowed");
  if (!fence) {
    expect(retained.client.socket.close).not.toHaveBeenCalled();
  }
  expect(retained.onRevoked).not.toHaveBeenCalled();
  expect(backend.socket.close).not.toHaveBeenCalled();
});

type Auth = NonNullable<NonNullable<OpenClawConfig["gateway"]>["auth"]>;
const authConfig = (auth: Auth): OpenClawConfig => ({ gateway: { auth } });

type Transition = {
  name: string;
  initial: OpenClawConfig;
  next: OpenClawConfig;
  principal: Parameters<typeof capture>[1];
  revoked: boolean;
};

const identity = "retained@example.test";
const grants = {
  "Retained@example.test": ["operator.write", "operator.read"],
  "other@example.test": ["operator.admin"],
} satisfies Record<string, OperatorScope[]>;
const identityChanges: Array<[string, Record<string, OperatorScope[]>, boolean]> = [
  ["another identity added", { ...grants, "new@example.test": ["operator.admin"] }, false],
  [
    "same scopes reordered",
    {
      ...grants,
      "Retained@example.test": ["operator.read", "operator.write", "operator.read"],
    },
    false,
  ],
  ["identity removed", { "other@example.test": grants["other@example.test"] }, true],
  ["identity downgraded", { ...grants, "Retained@example.test": ["operator.read"] }, true],
  ["exact match shadows normalized grant", { ...grants, [identity]: [] }, true],
];
const trustedProxy = {
  userHeader: "x-user",
  requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
  allowUsers: ["reader@example.test", "writer@example.test"],
};
const unorderedFields = ["requiredHeaders", "allowUsers"] as const;

it.each<Transition>([
  ...[false, true].map<Transition>((override) => ({
    name: `startup auth mode override ${override}`,
    initial: authConfig({ mode: "none" }),
    next: authConfig({ mode: "token" }),
    principal: {
      role: "operator",
      authMethod: "none",
      authModeOverride: override ? "none" : undefined,
    },
    revoked: !override,
  })),
  ...[
    { role: "operator", verifiedIdentity: undefined },
    { role: "node", verifiedIdentity: "other@example.test" },
  ].map<Transition>((principal) => ({
    name: `${principal.role} without identity-derived scopes`,
    initial: {},
    next: authConfig({ identityScopes: { "other@example.test": ["operator.admin"] } }),
    principal,
    revoked: false,
  })),
  ...identityChanges.map<Transition>(([name, scopes, revoked]) => ({
    name,
    initial: authConfig({ identityScopes: grants }),
    next: authConfig({ identityScopes: scopes }),
    principal: { role: "operator", verifiedIdentity: identity },
    revoked,
  })),
  ...unorderedFields.map<Transition>((field) => ({
    name: `trusted-proxy ${field} reordered`,
    initial: authConfig({ trustedProxy }),
    next: authConfig({
      trustedProxy: { ...trustedProxy, [field]: trustedProxy[field].toReversed() },
    }),
    principal: null,
    revoked: false,
  })),
  ...[
    "allowUsers",
    "proxy removed",
    "proxy disabled",
    "tailscale disabled",
    "tailscale default removed",
  ].map<Transition>((change) => {
    const tailscale = change.startsWith("tailscale");
    const initial: OpenClawConfig = {
      gateway: {
        tailscale: { mode: "serve" },
        auth: {
          mode: tailscale ? "token" : "trusted-proxy",
          allowTailscale: change === "tailscale default removed" ? undefined : true,
          trustedProxy: { userHeader: "x-user", allowUsers: [identity] },
        },
      },
    };
    const next = structuredClone(initial);
    if (change === "allowUsers") {
      next.gateway!.auth!.trustedProxy!.allowUsers = ["other@example.test"];
    } else if (change === "proxy removed") {
      delete next.gateway!.auth!.trustedProxy;
    } else if (change === "proxy disabled") {
      next.gateway!.auth!.mode = "token";
    } else if (change === "tailscale default removed") {
      next.gateway!.tailscale!.mode = "off";
    } else {
      next.gateway!.auth!.allowTailscale = false;
    }
    return {
      name: `${change} admission ends`,
      initial,
      next,
      principal: {
        role: "operator",
        authMethod: tailscale ? "tailscale" : "trusted-proxy",
        verifiedIdentity: identity,
      },
      revoked: true,
    };
  }),
])("reconciles the admitted grant after $name", ({ initial, next, principal, revoked }) => {
  const client = policyClient(initial, principal);
  const onRevoked = watchRevocation(client);
  reconcile([client], next);
  expect(client).toMatchObject({ invalidated: revoked, sourceInvalidated: revoked });
  expect(onRevoked).toHaveBeenCalledTimes(revoked ? 1 : 0);
  expect(client.socket.close).toHaveBeenCalledTimes(revoked ? 1 : 0);
  if (revoked) {
    expect(client.socket.close).toHaveBeenCalledWith(4001, "gateway policy changed");
  }
});

it.each(["retained@example.test", "other@example.test"])(
  "latches an added then removed grant only for its source: %s",
  (changedIdentity) => {
    const client = policyClient({}, { role: "operator", verifiedIdentity: identity });
    reconcile([client], {
      gateway: { auth: { identityScopes: { [changedIdentity]: ["operator.admin"] } } },
    });
    reconcile([client], {});
    expect(client.invalidated).toBe(changedIdentity === identity);
  },
);

it.each(["proxy addresses", "allowed users"])(
  "fences transport without revoking accepted work and drains its config response for %s",
  (change) => {
    const initial = authConfig({
      mode: "trusted-proxy",
      allowTailscale: true,
      trustedProxy: { userHeader: "x-user", allowUsers: [identity, "other@example.test"] },
    });
    const principal: Parameters<typeof capture>[1] = {
      role: "operator",
      authMethod: "trusted-proxy",
      verifiedIdentity: "retained@example.test",
    };
    const writer = policyClient(initial, principal);
    const onRevoked = watchRevocation(writer);
    const respond = vi.fn();
    const response = registerResponse("config.patch", writer, respond);
    holdResponse(respond);
    const nextConfig = structuredClone(initial);
    if (change === "proxy addresses") {
      nextConfig.gateway!.trustedProxies = ["192.0.2.10"];
    } else {
      nextConfig.gateway!.auth!.trustedProxy!.allowUsers = [identity];
    }
    const fresh = policyClient(nextConfig, principal);
    const worker = { socket: { close: vi.fn() } };

    reconcile([writer, fresh, worker], nextConfig);

    expect(writer).toMatchObject({ invalidated: true, sourceInvalidated: false });
    expect(onRevoked).not.toHaveBeenCalled();
    expect(writer.socket.close).not.toHaveBeenCalled();
    response?.finish();
    expect(writer.socket.close).toHaveBeenCalledExactlyOnceWith(4001, "gateway policy changed");
    expect(fresh.socket.close).not.toHaveBeenCalled();
    expect(worker.socket.close).not.toHaveBeenCalled();
  },
);
