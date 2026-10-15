import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureGatewayAuthPolicy, isGatewayAuthGrantCurrent } from "../auth-policy.js";
import type { OperatorScope } from "../operator-scopes.js";
import { GatewayClientRegistry } from "./client-registry.js";
import { disconnectDisallowedGatewayPolicyClients } from "./ws-origin-policy.js";
import {
  holdGatewayPolicyResponse,
  onGatewayPolicyClientInvalidated,
  registerGatewayPolicyResponse,
} from "./ws-policy-close.js";
import type { GatewayWsClient } from "./ws-types.js";

describe("committed browser origin policy", () => {
  it.each(["allowedOrigins", "publicOrigin", "host fallback"])(
    "revokes a fenced browser grant when its %s admission ends",
    (policy) => {
      const browserOrigin = {
        origin: "https://retained.example.test",
        requestHost: "retained.example.test",
        isLocalClient: false,
      };
      const initial: OpenClawConfig = {
        gateway: {
          publicOrigin: policy === "publicOrigin" ? browserOrigin.origin : undefined,
          controlUi: {
            allowedOrigins: policy === "allowedOrigins" ? [browserOrigin.origin] : undefined,
            dangerouslyAllowHostHeaderOriginFallback: policy === "host fallback",
          },
        },
      };
      const client = {
        browserOrigin,
        authPolicy: captureGatewayAuthPolicy(initial, { role: "operator", browserOrigin }),
        invalidated: false,
        sourceInvalidated: false,
        socket: { close: vi.fn() },
      };
      const onRevoked = vi.fn();
      onTestFinished(onGatewayPolicyClientInvalidated(client, onRevoked));
      const fenced = structuredClone(initial);
      fenced.gateway!.trustedProxies = ["192.0.2.10"];
      disconnectDisallowedGatewayPolicyClients([client], fenced);
      expect(client.socket.close).toHaveBeenCalledWith(4001, "gateway policy changed");
      expect(client.sourceInvalidated).toBe(false);
      expect(onRevoked).not.toHaveBeenCalled();
      expect(isGatewayAuthGrantCurrent(client.authPolicy, fenced)).toBe(true);
      const removed = structuredClone(fenced);
      delete removed.gateway!.publicOrigin;
      removed.gateway!.controlUi = { allowedOrigins: [] };
      expect(isGatewayAuthGrantCurrent(client.authPolicy, removed)).toBe(false);
      disconnectDisallowedGatewayPolicyClients([client], removed);
      expect(client.sourceInvalidated).toBe(true);
      expect(onRevoked).toHaveBeenCalledOnce();
      expect(client.socket.close).toHaveBeenLastCalledWith(1008, "origin not allowed");
    },
  );

  it("keeps origin grants separate for the same authenticated identity", () => {
    const origins = ["https://retained.example.test", "https://removed.example.test"];
    const initial: OpenClawConfig = { gateway: { controlUi: { allowedOrigins: origins } } };
    const clients = origins.map((origin) => {
      const browserOrigin = { origin, requestHost: "gateway.example.test", isLocalClient: false };
      return {
        browserOrigin,
        authPolicy: captureGatewayAuthPolicy(initial, {
          role: "operator",
          verifiedIdentity: "same@example.test",
          browserOrigin,
        }),
        socket: { close: vi.fn() },
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
  it.each([
    { policy: "allowedOrigins", transport: "live" },
    { policy: "dangerouslyAllowHostHeaderOriginFallback", transport: "disconnected" },
  ])(
    "retires only clients no longer admitted after $policy changes ($transport)",
    ({ policy, transport }) => {
      const revoked = {
        browserOrigin: {
          origin: "https://revoked.example.test",
          requestHost: "revoked.example.test",
          isLocalClient: false,
        },
        invalidated: false,
        invalidatedReason: undefined as string | undefined,
        socket: { close: vi.fn() },
      };
      const retained = {
        browserOrigin: {
          origin: "https://retained.example.test",
          requestHost: "gateway.example.test",
          isLocalClient: false,
        },
        socket: { close: vi.fn() },
      };
      const backend = { socket: { close: vi.fn() } };
      const registry = new GatewayClientRegistry([revoked, retained, backend] as never);
      const release = registry.retainRequest(revoked as unknown as GatewayWsClient);
      onTestFinished(release);
      if (transport === "disconnected") {
        registry.delete(revoked as unknown as GatewayWsClient);
      }
      const clients = registry.authorityClients;
      disconnectDisallowedGatewayPolicyClients(clients, {
        gateway: {
          controlUi: {
            allowedOrigins: [
              "https://retained.example.test",
              ...(policy === "allowedOrigins" ? ["https://revoked.example.test"] : []),
            ],
            dangerouslyAllowHostHeaderOriginFallback: policy !== "allowedOrigins",
          },
        },
      });
      expect(revoked.socket.close).not.toHaveBeenCalled();

      disconnectDisallowedGatewayPolicyClients(clients, {
        gateway: { controlUi: { allowedOrigins: ["https://retained.example.test"] } },
      });
      expect(revoked.socket.close).toHaveBeenCalledExactlyOnceWith(1008, "origin not allowed");
      expect(revoked.invalidated).toBe(true);
      expect(revoked.invalidatedReason).toBe("origin-policy-changed");
      expect(retained.socket.close).not.toHaveBeenCalled();
      expect(backend.socket.close).not.toHaveBeenCalled();
    },
  );
});

type AuthPolicyTransition = {
  name: string;
  initial: OpenClawConfig;
  next: OpenClawConfig;
  principal: Parameters<typeof captureGatewayAuthPolicy>[1];
  revoked: boolean;
};

describe("committed authentication policy", () => {
  const identity = "retained@example.test";
  const grants = {
    "Retained@example.test": ["operator.write", "operator.read"],
    "other@example.test": ["operator.admin"],
  } satisfies Record<string, OperatorScope[]>;
  const identityChanges: Array<{
    name: string;
    scopes: Record<string, OperatorScope[]>;
    revoked: boolean;
  }> = [
    {
      name: "another identity added",
      scopes: { ...grants, "new@example.test": ["operator.admin"] },
      revoked: false,
    },
    {
      name: "same scopes reordered",
      scopes: {
        ...grants,
        "Retained@example.test": ["operator.read", "operator.write", "operator.read"],
      },
      revoked: false,
    },
    {
      name: "identity removed",
      scopes: { "other@example.test": grants["other@example.test"] },
      revoked: true,
    },
    {
      name: "identity downgraded",
      scopes: { ...grants, "Retained@example.test": ["operator.read"] },
      revoked: true,
    },
    {
      name: "exact match shadows normalized grant",
      scopes: { ...grants, [identity]: [] },
      revoked: true,
    },
  ];
  const trustedProxy = {
    userHeader: "x-user",
    requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
    allowUsers: ["reader@example.test", "writer@example.test"],
  };
  const unorderedFields: Array<"requiredHeaders" | "allowUsers"> = [
    "requiredHeaders",
    "allowUsers",
  ];

  it.each<AuthPolicyTransition>([
    ...[false, true].map<AuthPolicyTransition>((override) => ({
      name: `startup auth mode override ${override}`,
      initial: { gateway: { auth: { mode: "none" } } },
      next: { gateway: { auth: { mode: "token" } } },
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
    ].map<AuthPolicyTransition>((principal) => ({
      name: `${principal.role} without identity-derived scopes`,
      initial: {},
      next: { gateway: { auth: { identityScopes: { "other@example.test": ["operator.admin"] } } } },
      principal,
      revoked: false,
    })),
    ...identityChanges.map<AuthPolicyTransition>(({ name, scopes, revoked }) => ({
      name,
      initial: { gateway: { auth: { identityScopes: grants } } },
      next: { gateway: { auth: { identityScopes: scopes } } },
      principal: { role: "operator", verifiedIdentity: identity },
      revoked,
    })),
    ...unorderedFields.map<AuthPolicyTransition>((field) => ({
      name: `trusted-proxy ${field} reordered`,
      initial: { gateway: { auth: { trustedProxy } } },
      next: {
        gateway: {
          auth: { trustedProxy: { ...trustedProxy, [field]: trustedProxy[field].toReversed() } },
        },
      },
      principal: null,
      revoked: false,
    })),
    ...[
      "allowUsers",
      "proxy removed",
      "proxy disabled",
      "tailscale disabled",
      "tailscale default removed",
    ].map<AuthPolicyTransition>((change) => {
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
    const client = {
      authPolicy: captureGatewayAuthPolicy(initial, principal),
      invalidated: false,
      sourceInvalidated: false,
      socket: { close: vi.fn() },
    };
    const onRevoked = vi.fn();
    onTestFinished(onGatewayPolicyClientInvalidated(client, onRevoked));
    disconnectDisallowedGatewayPolicyClients([client], next);
    expect(client.invalidated).toBe(revoked);
    expect(client.sourceInvalidated).toBe(revoked);
    expect(onRevoked).toHaveBeenCalledTimes(revoked ? 1 : 0);
    expect(client.socket.close).toHaveBeenCalledTimes(revoked ? 1 : 0);
    if (revoked) {
      expect(client.socket.close).toHaveBeenCalledWith(4001, "gateway policy changed");
    }
  });

  it.each(["retained@example.test", "other@example.test"])(
    "latches an added then removed grant only for its source: %s",
    (changedIdentity) => {
      const client = {
        authenticatedUserId: identity,
        authPolicy: captureGatewayAuthPolicy({}, { role: "operator", verifiedIdentity: identity }),
        socket: { close: vi.fn() },
        invalidated: false,
      };
      disconnectDisallowedGatewayPolicyClients([client], {
        gateway: { auth: { identityScopes: { [changedIdentity]: ["operator.admin"] } } },
      });
      disconnectDisallowedGatewayPolicyClients([client], {});
      expect(client.invalidated).toBe(changedIdentity === identity);
    },
  );

  it.each<OpenClawConfig["gateway"]>([
    { trustedProxies: ["192.0.2.10"] },
    { auth: { trustedProxy: { userHeader: "x-user", allowUsers: ["retained@example.test"] } } },
    {
      roles: {
        default: "reader",
        definitions: {
          reader: { scopes: ["operator.read"], agents: [], sessions: { others: "none" } },
        },
      },
    },
  ])(
    "fences transport without revoking accepted work and drains its config response for %j",
    (gateway) => {
      const initial: OpenClawConfig = {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            allowTailscale: true,
            trustedProxy: {
              userHeader: "x-user",
              allowUsers: ["retained@example.test", "other@example.test"],
            },
          },
        },
      };
      const principal: Parameters<typeof captureGatewayAuthPolicy>[1] = {
        role: "operator",
        authMethod: "trusted-proxy",
        verifiedIdentity: "retained@example.test",
      };
      const writer = {
        authPolicy: captureGatewayAuthPolicy(initial, principal),
        sourceInvalidated: false,
        socket: { close: vi.fn() },
        invalidated: false,
      };
      const onRevoked = vi.fn();
      onTestFinished(onGatewayPolicyClientInvalidated(writer, onRevoked));
      const respond = vi.fn();
      const response = registerGatewayPolicyResponse("config.patch", writer, respond);
      holdGatewayPolicyResponse(respond);
      const nextConfig: OpenClawConfig = {
        gateway: {
          ...initial.gateway,
          ...gateway,
          auth: {
            ...initial.gateway!.auth,
            ...gateway?.auth,
            trustedProxy: {
              ...initial.gateway!.auth!.trustedProxy!,
              ...gateway?.auth?.trustedProxy,
            },
          },
        },
      };
      const fresh = {
        authPolicy: captureGatewayAuthPolicy(nextConfig, principal),
        socket: { close: vi.fn() },
      };
      const worker = { socket: { close: vi.fn() } };

      disconnectDisallowedGatewayPolicyClients([writer, fresh, worker], nextConfig);

      expect(writer.invalidated).toBe(true);
      expect(writer.sourceInvalidated).toBe(false);
      expect(onRevoked).not.toHaveBeenCalled();
      expect(writer.socket.close).not.toHaveBeenCalled();
      response?.finish();
      expect(writer.socket.close).toHaveBeenCalledExactlyOnceWith(4001, "gateway policy changed");
      expect(fresh.socket.close).not.toHaveBeenCalled();
      expect(worker.socket.close).not.toHaveBeenCalled();
    },
  );
});
