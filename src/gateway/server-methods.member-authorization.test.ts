import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayPrincipal } from "../../packages/gateway-protocol/src/schema/frames.js";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  bindGatewayClientAuthorizationDomain,
  bindGatewayClientTeamsSession,
} from "./authorization/client-domain.js";
import type { GatewayMethodAccessPolicy, GatewayResourceRef } from "./authorization/contracts.js";
import {
  addIsolationDomainMember,
  bindAuthorizationResource,
  createIsolationDomain,
  grantAuthorizationPermission,
  putAuthorizationPrincipal,
} from "./authorization/state-store.js";
import {
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptor,
} from "./methods/registry.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient, GatewayRequestHandler } from "./server-methods/types.js";

const mocks = vi.hoisted(() => ({ resolveTeamsSessionById: vi.fn() }));

vi.mock("./authorization/teams-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./authorization/teams-identity.js")>()),
  resolveTeamsSessionById: mocks.resolveTeamsSessionById,
}));

const tempDirs: string[] = [];
const owner = {
  id: "principal-owner",
  principal: { issuer: "teams", subject: "owner@example.com", kind: "human" as const },
};
const member = {
  id: "principal-member",
  principal: { issuer: "teams", subject: "member@example.com", kind: "human" as const },
};
const tab: GatewayResourceRef = { namespace: "workspaces", type: "tab", id: "tab-1" };
const access: GatewayMethodAccessPolicy = {
  kind: "resource",
  member: true,
  permission: "workspaces.tab.read",
  resolveResources: () => [tab],
};

function seedDomain(params: { domainId: string; grant?: boolean }) {
  putAuthorizationPrincipal(owner);
  putAuthorizationPrincipal(member);
  createIsolationDomain({ id: params.domainId, ownerPrincipalId: owner.id });
  addIsolationDomainMember({
    domainId: params.domainId,
    principalId: member.id,
    addedByPrincipalId: owner.id,
  });
  bindAuthorizationResource({
    domainId: params.domainId,
    resource: tab,
    ownerPrincipalId: owner.id,
  });
  if (params.grant) {
    grantAuthorizationPermission({
      domainId: params.domainId,
      principalId: member.id,
      resource: tab,
      permission: "workspaces.tab.read",
      grantedByPrincipalId: owner.id,
    });
  }
}

function makeClient(params: {
  role: "member" | "operator";
  scopes?: string[];
  principal?: GatewayPrincipal;
  domainId?: string;
}): GatewayClient {
  const client: GatewayClient = {
    connId: "conn-member",
    connect: {
      role: params.role,
      scopes: params.scopes ?? [],
      client: { id: "test", version: "1", platform: "test", mode: "test" },
      minProtocol: 1,
      maxProtocol: 1,
    },
    ...(params.principal ? { principal: params.principal } : {}),
  };
  if (params.domainId) {
    bindGatewayClientAuthorizationDomain(client, { id: params.domainId });
    if (params.role === "member" && params.principal?.kind === "human") {
      bindGatewayClientTeamsSession(client, {
        id: `teams-session-${params.domainId}`,
        principalId: member.id,
        domainId: params.domainId,
      });
    }
  }
  return client;
}

async function dispatch(params: {
  role?: "member" | "operator";
  scopes?: string[];
  principal?: GatewayPrincipal;
  domainId?: string;
  access?: GatewayMethodAccessPolicy;
  method?: string;
}) {
  const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
  const method = params.method ?? "workspaces.tab.get";
  const registry = createGatewayMethodRegistry([
    createPluginGatewayMethodDescriptor({
      pluginId: "workspaces",
      name: method,
      handler,
      scope: "operator.admin",
      access: params.access,
    }),
  ]);
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: "req-member", method, params: { id: tab.id } },
    respond,
    client: makeClient({
      role: params.role ?? "member",
      scopes: params.scopes,
      principal: params.principal,
      domainId: params.domainId,
    }),
    isWebchatConnect: () => false,
    context: {
      authorization: { mode: "legacy" },
      getRuntimeConfig: () => ({}),
      logGateway: { warn: vi.fn() },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
    methodRegistry: registry,
  });
  return { handler, respond };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

afterAll(() => cleanupTempDirs(tempDirs));

describe("member gateway authorization", () => {
  beforeEach(() => {
    mocks.resolveTeamsSessionById.mockImplementation(({ id }: { id: string }) => {
      const domainId = id.replace(/^teams-session-/, "");
      return {
        id,
        principalId: member.id,
        principal: member.principal,
        domainId,
        state: "active",
        accountId: "account-member",
        createdAt: 1,
        expiresAt: Date.now() + 60_000,
        revokedAt: null,
        revokedByPrincipalId: null,
      };
    });
  });

  function useDatabase() {
    vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(tempDirs, "openclaw-member-dispatch-"));
  }

  it("allows an exact resource grant without operator scopes", async () => {
    useDatabase();
    seedDomain({ domainId: "domain-1", grant: true });

    const { handler, respond } = await dispatch({
      principal: member.principal,
      domainId: "domain-1",
      access,
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("does not let broad operator scopes affect member authorization", async () => {
    useDatabase();
    seedDomain({ domainId: "domain-1", grant: true });

    const { handler } = await dispatch({
      scopes: ["operator.admin"],
      principal: member.principal,
      domainId: "domain-1",
      access,
    });

    expect(handler).toHaveBeenCalledOnce();
  });

  it("denies member methods without a resource access policy", async () => {
    useDatabase();
    const { handler, respond } = await dispatch({ scopes: ["operator.admin"] });

    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "authentication required" }),
    );
  });

  it("denies resource methods that did not explicitly opt into the member surface", async () => {
    useDatabase();
    seedDomain({ domainId: "domain-1", grant: true });
    const { member: _member, ...operatorOnlyAccess } = access;

    const { handler, respond } = await dispatch({
      principal: member.principal,
      domainId: "domain-1",
      access: operatorOnlyAccess,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "unauthorized role: member" }),
    );
  });

  it.each(["config.get", "sessions.list", "agent", "terminal.open"])(
    "denies the core method %s even if a descriptor claims resource access",
    async (method) => {
      useDatabase();
      const { handler } = await dispatch({
        method,
        scopes: ["operator.admin"],
        principal: member.principal,
        domainId: "domain-1",
        access,
      });

      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("denies an unbound member before dispatch", async () => {
    useDatabase();
    const { handler, respond } = await dispatch({ principal: member.principal, access });

    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "authentication required" }),
    );
  });

  it("denies the same established member client after its Teams session is revoked", async () => {
    useDatabase();
    seedDomain({ domainId: "domain-1", grant: true });
    mocks.resolveTeamsSessionById.mockReturnValue(undefined);

    const { handler, respond } = await dispatch({
      principal: member.principal,
      domainId: "domain-1",
      access,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "authentication required" }),
    );
  });

  it("denies missing grants and cross-domain resources through state authorization", async () => {
    useDatabase();
    seedDomain({ domainId: "domain-1" });
    createIsolationDomain({ id: "domain-2", ownerPrincipalId: owner.id });
    addIsolationDomainMember({
      domainId: "domain-2",
      principalId: member.id,
      addedByPrincipalId: owner.id,
    });

    const forbidden = await dispatch({
      principal: member.principal,
      domainId: "domain-1",
      access,
    });
    const crossDomain = await dispatch({
      principal: member.principal,
      domainId: "domain-2",
      access,
    });

    expect(forbidden.handler).not.toHaveBeenCalled();
    expect(crossDomain.handler).not.toHaveBeenCalled();
    expect(forbidden.respond.mock.calls[0]).toEqual(crossDomain.respond.mock.calls[0]);
  });

  it("requires state authorization for a domain-bound service client", async () => {
    useDatabase();
    seedDomain({ domainId: "domain-1", grant: true });

    const { handler } = await dispatch({
      scopes: ["operator.admin"],
      principal: { issuer: "core", subject: "agent:main", kind: "service" },
      domainId: "domain-1",
      access,
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("does not let a domain-bound operator use legacy admin scope to bypass resource policy", async () => {
    useDatabase();
    seedDomain({ domainId: "domain-1", grant: true });

    const { handler } = await dispatch({
      role: "operator",
      scopes: ["operator.admin"],
      principal: member.principal,
      domainId: "domain-1",
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("preserves legacy scope dispatch for unbound operators", async () => {
    useDatabase();
    const { handler, respond } = await dispatch({
      role: "operator",
      scopes: ["operator.admin"],
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });
});
