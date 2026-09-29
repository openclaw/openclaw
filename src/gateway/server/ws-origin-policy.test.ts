import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureGatewayAuthPolicy } from "../auth-policy.js";
import { GatewayClientRegistry } from "./client-registry.js";
import { disconnectDisallowedGatewayPolicyClients } from "./ws-origin-policy.js";
import {
  holdGatewayPolicyResponse,
  onGatewayPolicyClientInvalidated,
  registerGatewayPolicyResponse,
} from "./ws-policy-close.js";
import type { GatewayWsClient } from "./ws-types.js";

describe("committed browser origin policy", () => {
  it.each(
    (["allowedOrigins", "dangerouslyAllowHostHeaderOriginFallback"] as const).flatMap((policy) =>
      ["live", "disconnected"].map((transport) => ({ policy, transport })),
    ),
  )(
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

describe("committed authentication policy", () => {
  it.each([
    { role: "operator", verifiedIdentity: undefined },
    { role: "node", verifiedIdentity: "other@example.test" },
  ])("keeps $role without identity-derived scopes connected across grant edits", (principal) => {
    const client = {
      authPolicy: captureGatewayAuthPolicy({}, principal),
      socket: { close: vi.fn() },
      invalidated: false,
    };
    disconnectDisallowedGatewayPolicyClients([client], {
      gateway: { auth: { identityScopes: { "other@example.test": ["operator.admin"] } } },
    });
    expect(client.invalidated).toBe(false);
    expect(client.socket.close).not.toHaveBeenCalled();
  });

  it.each([
    { change: "another identity added", revoked: false },
    { change: "another identity removed", revoked: false },
    { change: "unchanged snapshot", revoked: false },
    { change: "same scopes reordered", revoked: false },
    { change: "identity removed", revoked: true },
    { change: "identity downgraded", revoked: true },
    { change: "identity upgraded", revoked: true },
    { change: "exact match shadows normalized grant", revoked: true },
  ])("reconciles only the authenticated identity for $change", ({ change, revoked }) => {
    const identity = "retained@example.test";
    const initial: OpenClawConfig = {
      gateway: {
        auth: {
          identityScopes: {
            "Retained@example.test": ["operator.write", "operator.read"],
            "other@example.test": ["operator.admin"],
          },
        },
      },
    };
    const client = {
      authenticatedUserId: identity,
      authPolicy: captureGatewayAuthPolicy(initial, {
        role: "operator",
        verifiedIdentity: identity,
      }),
      socket: { close: vi.fn() },
      invalidated: false,
      sourceInvalidated: false,
    };
    const onRevoked = vi.fn();
    onTestFinished(onGatewayPolicyClientInvalidated(client, onRevoked));
    const next = structuredClone(initial);
    const scopes = next.gateway!.auth!.identityScopes!;
    if (change === "another identity added") {
      scopes["new@example.test"] = ["operator.admin"];
    }
    if (change === "another identity removed") {
      delete scopes["other@example.test"];
    }
    if (change === "same scopes reordered") {
      scopes["Retained@example.test"] = ["operator.read", "operator.write", "operator.read"];
    }
    if (change === "identity removed") {
      delete scopes["Retained@example.test"];
    }
    if (change === "identity downgraded") {
      scopes["Retained@example.test"] = ["operator.read"];
    }
    if (change === "identity upgraded") {
      scopes["Retained@example.test"] = ["operator.admin"];
    }
    if (change === "exact match shadows normalized grant") {
      scopes[identity] = [];
    }
    disconnectDisallowedGatewayPolicyClients([client], next);
    expect(client.invalidated).toBe(revoked);
    expect(client.sourceInvalidated).toBe(revoked);
    expect(onRevoked).toHaveBeenCalledTimes(revoked ? 1 : 0);
    if (revoked) {
      expect(client.socket.close).toHaveBeenCalledWith(4001, "gateway policy changed");
    }
    expect(client.socket.close).toHaveBeenCalledTimes(revoked ? 1 : 0);
  });

  it.each(["retained@example.test", "other@example.test"])(
    "latches an added then removed grant only for its source: %s",
    (changedIdentity) => {
      const identity = "retained@example.test";
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

  it.each(["requiredHeaders", "allowUsers"] as const)(
    "keeps clients connected when trusted-proxy %s are reordered",
    (field) => {
      const trustedProxy = {
        userHeader: "x-user",
        requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
        allowUsers: ["reader@example.test", "writer@example.test"],
      };
      const client = {
        authPolicy: captureGatewayAuthPolicy(
          {
            gateway: { auth: { trustedProxy } },
          },
          null,
        ),
        socket: { close: vi.fn() },
        invalidated: false,
      };
      disconnectDisallowedGatewayPolicyClients([client], {
        gateway: {
          auth: { trustedProxy: { ...trustedProxy, [field]: trustedProxy[field].toReversed() } },
        },
      });
      expect(client.socket.close).not.toHaveBeenCalled();
      expect(client.invalidated).toBe(false);
    },
  );

  it.each<OpenClawConfig["gateway"]>([
    { trustedProxies: ["192.0.2.10"] },
    { allowRealIpFallback: true },
    { auth: { allowTailscale: false } },
    { auth: { trustedProxy: { userHeader: "x-user", allowUsers: ["retained@example.test"] } } },
    { auth: { trustedProxy: { userHeader: "x-new-user" } } },
    { auth: { trustedProxy: { userHeader: "x-user", requiredHeaders: ["x-forwarded-proto"] } } },
    { auth: { trustedProxy: { userHeader: "x-user", allowLoopback: true } } },
    {
      auth: {
        trustedProxy: {
          userHeader: "x-user",
          cloudflareAccessOidc: {
            issuer: "https://fixture.cloudflareaccess.com",
            providerId: "fixture-provider",
            githubAccountIdClaim: "github_id",
          },
        },
      },
    },
    { auth: { trustedProxy: { userHeader: "x-user", deviceAutoApprove: { enabled: true } } } },
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

  it.each([
    "allowUsers",
    "proxy removed",
    "proxy disabled",
    "tailscale disabled",
    "tailscale default removed",
  ])("revokes accepted work when its admission grant ends: %s", (change) => {
    const tailscale = change.startsWith("tailscale");
    const initial: OpenClawConfig = {
      gateway: {
        tailscale: { mode: "serve" },
        auth: {
          mode: tailscale ? "token" : "trusted-proxy",
          allowTailscale: change === "tailscale default removed" ? undefined : true,
          trustedProxy: { userHeader: "x-user", allowUsers: ["retained@example.test"] },
        },
      },
    };
    const client = {
      authPolicy: captureGatewayAuthPolicy(initial, {
        role: "operator",
        authMethod: tailscale ? "tailscale" : "trusted-proxy",
        verifiedIdentity: "retained@example.test",
      }),
      invalidated: false,
      sourceInvalidated: false,
      socket: { close: vi.fn() },
    };
    const onRevoked = vi.fn();
    onTestFinished(onGatewayPolicyClientInvalidated(client, onRevoked));
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
    disconnectDisallowedGatewayPolicyClients([client], next);
    expect(client.sourceInvalidated).toBe(true);
    expect(onRevoked).toHaveBeenCalledOnce();
    expect(client.socket.close).toHaveBeenCalledExactlyOnceWith(4001, "gateway policy changed");
  });
});
