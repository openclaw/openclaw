import { describe, expect, it } from "vitest";
import type { GatewayClient } from "../server-methods/types.js";
import {
  bindGatewayClientAuthorizationDelegation,
  bindGatewayClientAuthorizationDomain,
  bindGatewayClientTeamsSession,
  getGatewayClientAuthorizationDelegation,
  getGatewayClientAuthorizationDomain,
  getGatewayClientTeamsSession,
  inheritGatewayClientAuthorizationDelegation,
  inheritGatewayClientAuthorizationDomain,
  inheritGatewayClientTeamsSession,
} from "./client-domain.js";

function client(): GatewayClient {
  return {
    connect: {
      role: "operator",
      scopes: ["operator.write"],
      client: { id: "test", version: "1", platform: "test", mode: "test" },
      minProtocol: 1,
      maxProtocol: 1,
    },
  };
}

function serviceClient(): GatewayClient {
  return {
    ...client(),
    principal: { issuer: "core", subject: "agent:main", kind: "service" },
  };
}

function humanClient(): GatewayClient {
  return {
    ...client(),
    connect: { ...client().connect, role: "member", scopes: [] },
    principal: { issuer: "local", subject: "member@example.com", kind: "human" },
  };
}

describe("server-owned gateway client domain", () => {
  it("ignores plugin-visible object mutation", () => {
    const gatewayClient = client();
    bindGatewayClientAuthorizationDomain(gatewayClient, { id: "domain-1" });

    (
      gatewayClient as GatewayClient & { authorizationDomain?: { id: string } }
    ).authorizationDomain = {
      id: "domain-2",
    };

    expect(getGatewayClientAuthorizationDomain(gatewayClient)).toEqual({ id: "domain-1" });
  });

  it("is idempotent for one domain and rejects rebinding", () => {
    const gatewayClient = client();
    bindGatewayClientAuthorizationDomain(gatewayClient, { id: "domain-1" });
    expect(() =>
      bindGatewayClientAuthorizationDomain(gatewayClient, { id: "domain-1" }),
    ).not.toThrow();
    expect(() => bindGatewayClientAuthorizationDomain(gatewayClient, { id: "domain-2" })).toThrow(
      /already bound differently/i,
    );
  });

  it("copies the private binding only through the core inheritance helper", () => {
    const source = client();
    const target = { ...source };
    bindGatewayClientAuthorizationDomain(source, { id: "domain-1" });

    expect(getGatewayClientAuthorizationDomain(target)).toBeUndefined();
    inheritGatewayClientAuthorizationDomain(source, target);
    expect(getGatewayClientAuthorizationDomain(target)).toEqual({ id: "domain-1" });
  });
});

describe("server-owned gateway client Teams session", () => {
  it("binds privately, rejects rebinding, and inherits only across the same human domain", () => {
    const source = humanClient();
    const target = { ...source };
    bindGatewayClientAuthorizationDomain(source, { id: "domain-1" });
    bindGatewayClientTeamsSession(source, {
      id: "session-1",
      principalId: "principal-member",
      domainId: "domain-1",
    });
    (source as GatewayClient & { teamsSessionId?: string }).teamsSessionId = "forged";

    expect(getGatewayClientTeamsSession(source)).toEqual({
      id: "session-1",
      principalId: "principal-member",
      domainId: "domain-1",
    });
    expect(() =>
      bindGatewayClientTeamsSession(source, {
        id: "session-2",
        principalId: "principal-member",
        domainId: "domain-1",
      }),
    ).toThrow(/already bound differently/i);
    expect(getGatewayClientTeamsSession(target)).toBeUndefined();
    inheritGatewayClientAuthorizationDomain(source, target);
    inheritGatewayClientTeamsSession(source, target);
    expect(getGatewayClientTeamsSession(target)?.id).toBe("session-1");

    const different = { ...source, principal: { ...source.principal!, subject: "other" } };
    bindGatewayClientAuthorizationDomain(different, { id: "domain-1" });
    expect(() => inheritGatewayClientTeamsSession(source, different)).toThrow(/cannot cross/i);
  });
});

describe("server-owned gateway client delegation", () => {
  it("ignores plugin-visible mutation and rejects rebinding", () => {
    const gatewayClient = serviceClient();
    bindGatewayClientAuthorizationDomain(gatewayClient, { id: "domain-1" });
    bindGatewayClientAuthorizationDelegation(gatewayClient, {
      id: "delegation-1",
      assignmentId: "assignment-1",
    });

    (
      gatewayClient as GatewayClient & {
        internal: { authorizationDelegation: { id: string; assignmentId: string } };
      }
    ).internal = {
      authorizationDelegation: { id: "forged", assignmentId: "forged" },
    };

    expect(getGatewayClientAuthorizationDelegation(gatewayClient)).toEqual({
      id: "delegation-1",
      assignmentId: "assignment-1",
    });
    expect(() =>
      bindGatewayClientAuthorizationDelegation(gatewayClient, {
        id: "delegation-2",
        assignmentId: "assignment-2",
      }),
    ).toThrow(/already bound differently/i);
  });

  it("requires a scoped service client and inherits only through the core helper", () => {
    const human = client();
    bindGatewayClientAuthorizationDomain(human, { id: "domain-1" });
    expect(() =>
      bindGatewayClientAuthorizationDelegation(human, {
        id: "delegation-1",
        assignmentId: "assignment-1",
      }),
    ).toThrow(/service principal/i);

    const source = serviceClient();
    const target = { ...source };
    bindGatewayClientAuthorizationDomain(source, { id: "domain-1" });
    bindGatewayClientAuthorizationDelegation(source, {
      id: "delegation-1",
      assignmentId: "assignment-1",
    });

    expect(getGatewayClientAuthorizationDelegation(target)).toBeUndefined();
    inheritGatewayClientAuthorizationDomain(source, target);
    inheritGatewayClientAuthorizationDelegation(source, target);
    expect(getGatewayClientAuthorizationDelegation(target)).toEqual({
      id: "delegation-1",
      assignmentId: "assignment-1",
    });
  });
});
