import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  createAuthorizationAgentSessionBinding,
  GATEWAY_AGENT_SESSION_INVOKE_PERMISSION,
  resolveAuthorizedGatewayAgentAuthorizationSubject,
  resolveGatewayAgentAuthorizationSubject,
  revokeAuthorizationAgentSessionBinding,
} from "./agent-session-bindings.js";
import {
  createAuthorizationDelegation,
  revokeAuthorizationDelegation,
} from "./delegations.test-support.js";
import { createStateGatewayAuthorizationRuntime } from "./state-provider.js";
import {
  addIsolationDomainMember,
  bindAuthorizationResource,
  createIsolationDomain,
  grantAuthorizationPermission,
  putAuthorizationPrincipal,
  revokeAuthorizationPermission,
  transferAuthorizationResourceOwner,
} from "./state-store.js";

const tempDirs: string[] = [];

const owner = {
  id: "principal-owner",
  principal: { issuer: "trusted-proxy", subject: "owner@example.com", kind: "human" },
} as const;
const service = {
  id: "principal-service",
  principal: { issuer: "core", subject: "agent:main", kind: "service" },
} as const;
const member = {
  id: "principal-member",
  principal: { issuer: "trusted-proxy", subject: "member@example.com", kind: "human" },
} as const;
const agentSessionResource = {
  namespace: "core",
  type: "agent-session",
  id: "assignment-1",
} as const;

function createDatabase() {
  return { path: `${makeTempDir(tempDirs, "openclaw-agent-session-binding-")}/openclaw.sqlite` };
}

function seedDelegation(database: ReturnType<typeof createDatabase>) {
  putAuthorizationPrincipal({ ...owner, database });
  putAuthorizationPrincipal({ ...service, database });
  createIsolationDomain({
    id: "domain-1",
    ownerPrincipalId: owner.id,
    database,
  });
  addIsolationDomainMember({
    domainId: "domain-1",
    principalId: service.id,
    addedByPrincipalId: owner.id,
    database,
  });
  createAuthorizationDelegation({
    id: "delegation-1",
    assignmentId: "assignment-1",
    domainId: "domain-1",
    agentPrincipalId: service.id,
    sponsorPrincipalId: owner.id,
    createdByPrincipalId: owner.id,
    database,
  });
}

function bindMainSession(database: ReturnType<typeof createDatabase>) {
  bindAuthorizationResource({
    domainId: "domain-1",
    resource: agentSessionResource,
    ownerPrincipalId: owner.id,
    database,
  });
  createAuthorizationAgentSessionBinding({
    id: "binding-1",
    domainId: "domain-1",
    runtimeAgentId: "main",
    sessionKey: "agent:main:main",
    delegationId: "delegation-1",
    assignmentId: "assignment-1",
    createdByPrincipalId: owner.id,
    database,
  });
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("authorization agent session bindings", () => {
  it("resolves one exact active session assignment to a canonical frozen subject", () => {
    const database = createDatabase();
    seedDelegation(database);
    bindMainSession(database);

    const subject = resolveGatewayAgentAuthorizationSubject({
      runtimeAgentId: "main",
      sessionKey: "agent:main:main",
      database,
    });

    expect(subject).toEqual({
      principal: service.principal,
      domain: { id: "domain-1" },
      delegation: { id: "delegation-1", assignmentId: "assignment-1" },
    });
    expect(Object.isFrozen(subject)).toBe(true);
    expect(Object.isFrozen(subject?.principal)).toBe(true);
    expect(Object.isFrozen(subject?.domain)).toBe(true);
    expect(Object.isFrozen(subject?.delegation)).toBe(true);
  });

  it("fails closed for a different agent, session, or missing binding", () => {
    const database = createDatabase();
    seedDelegation(database);
    bindMainSession(database);

    expect(
      resolveGatewayAgentAuthorizationSubject({
        runtimeAgentId: "other",
        sessionKey: "agent:main:main",
        database,
      }),
    ).toBeUndefined();
    expect(
      resolveGatewayAgentAuthorizationSubject({
        runtimeAgentId: "main",
        sessionKey: "agent:main:other",
        database,
      }),
    ).toBeUndefined();
    expect(
      resolveGatewayAgentAuthorizationSubject({
        runtimeAgentId: "main",
        sessionKey: "agent:main:missing",
        database,
      }),
    ).toBeUndefined();
  });

  it("rejects ambiguous runtime identities and differently bound idempotent retries", () => {
    const database = createDatabase();
    seedDelegation(database);
    bindMainSession(database);

    expect(() =>
      createAuthorizationAgentSessionBinding({
        id: "binding-other",
        domainId: "domain-1",
        runtimeAgentId: "main",
        sessionKey: "agent:main:main",
        delegationId: "delegation-1",
        assignmentId: "assignment-1",
        createdByPrincipalId: owner.id,
        database,
      }),
    ).toThrow(/already bound/i);

    expect(() =>
      createAuthorizationAgentSessionBinding({
        id: "binding-1",
        domainId: "domain-1",
        runtimeAgentId: "main",
        sessionKey: "agent:main:other",
        delegationId: "delegation-1",
        assignmentId: "assignment-1",
        createdByPrincipalId: owner.id,
        database,
      }),
    ).toThrow(/already bound/i);
  });

  it("allows an explicit new binding identity after a revoked runtime tombstone", () => {
    const database = createDatabase();
    seedDelegation(database);
    bindMainSession(database);
    revokeAuthorizationAgentSessionBinding({
      domainId: "domain-1",
      id: "binding-1",
      revokedByPrincipalId: owner.id,
      database,
    });

    expect(() => bindMainSession(database)).toThrow(/revoked/i);
    expect(() =>
      createAuthorizationAgentSessionBinding({
        id: "binding-2",
        domainId: "domain-1",
        runtimeAgentId: "main",
        sessionKey: "agent:main:main",
        delegationId: "delegation-1",
        assignmentId: "assignment-1",
        createdByPrincipalId: owner.id,
        database,
      }),
    ).not.toThrow();
    expect(
      resolveGatewayAgentAuthorizationSubject({
        runtimeAgentId: "main",
        sessionKey: "agent:main:main",
        database,
      }),
    ).toMatchObject({ delegation: { assignmentId: "assignment-1" } });
  });

  it("requires the invoking human to own or hold an exact agent-session grant", async () => {
    const database = createDatabase();
    seedDelegation(database);
    bindMainSession(database);
    putAuthorizationPrincipal({ ...member, database });
    addIsolationDomainMember({
      domainId: "domain-1",
      principalId: member.id,
      addedByPrincipalId: owner.id,
      database,
    });

    await expect(
      resolveAuthorizedGatewayAgentAuthorizationSubject({
        invokingPrincipal: owner.principal,
        runtimeAgentId: "main",
        sessionKey: "agent:main:main",
        database,
      }),
    ).resolves.toMatchObject({
      principal: service.principal,
      agentSession: { id: "binding-1", invokingPrincipal: owner.principal },
    });
    await expect(
      resolveAuthorizedGatewayAgentAuthorizationSubject({
        invokingPrincipal: member.principal,
        runtimeAgentId: "main",
        sessionKey: "agent:main:main",
        database,
      }),
    ).resolves.toBeUndefined();

    grantAuthorizationPermission({
      domainId: "domain-1",
      resource: agentSessionResource,
      principalId: member.id,
      permission: GATEWAY_AGENT_SESSION_INVOKE_PERMISSION,
      grantedByPrincipalId: owner.id,
      database,
    });
    await expect(
      resolveAuthorizedGatewayAgentAuthorizationSubject({
        invokingPrincipal: member.principal,
        runtimeAgentId: "main",
        sessionKey: "agent:main:main",
        database,
      }),
    ).resolves.toMatchObject({
      principal: service.principal,
      delegation: { id: "delegation-1", assignmentId: "assignment-1" },
      agentSession: { id: "binding-1", invokingPrincipal: member.principal },
    });
  });

  it("keeps an active agent-session resource with its canonical sponsor owner", async () => {
    const database = createDatabase();
    seedDelegation(database);
    bindMainSession(database);
    putAuthorizationPrincipal({ ...member, database });
    addIsolationDomainMember({
      domainId: "domain-1",
      principalId: member.id,
      addedByPrincipalId: owner.id,
      database,
    });

    expect(() =>
      transferAuthorizationResourceOwner({
        domainId: "domain-1",
        resource: agentSessionResource,
        transferredByPrincipalId: owner.id,
        newOwnerPrincipalId: member.id,
        database,
      }),
    ).toThrow(/canonical sponsor owner/i);
    expect(() =>
      openOpenClawStateDatabase(database)
        .db.prepare(
          `UPDATE authorization_resources
           SET owner_principal_id = ?, updated_at = ?
           WHERE domain_id = ? AND namespace = ? AND resource_type = ? AND resource_id = ?`,
        )
        .run(
          member.id,
          Date.now(),
          "domain-1",
          agentSessionResource.namespace,
          agentSessionResource.type,
          agentSessionResource.id,
        ),
    ).toThrow(/canonical sponsor owner/i);
    await expect(
      resolveAuthorizedGatewayAgentAuthorizationSubject({
        invokingPrincipal: member.principal,
        runtimeAgentId: "main",
        sessionKey: "agent:main:main",
        database,
      }),
    ).resolves.toBeUndefined();
  });

  it("revalidates the binding and invoking human permission for every tool decision", async () => {
    const database = createDatabase();
    seedDelegation(database);
    bindMainSession(database);
    putAuthorizationPrincipal({ ...member, database });
    addIsolationDomainMember({
      domainId: "domain-1",
      principalId: member.id,
      addedByPrincipalId: owner.id,
      database,
    });
    grantAuthorizationPermission({
      domainId: "domain-1",
      resource: agentSessionResource,
      principalId: member.id,
      permission: GATEWAY_AGENT_SESSION_INVOKE_PERMISSION,
      grantedByPrincipalId: owner.id,
      database,
    });
    grantAuthorizationPermission({
      domainId: "domain-1",
      resource: agentSessionResource,
      principalId: service.id,
      permission: "plugin.tool.read",
      grantedByPrincipalId: owner.id,
      database,
    });
    const subject = await resolveAuthorizedGatewayAgentAuthorizationSubject({
      invokingPrincipal: member.principal,
      runtimeAgentId: "main",
      sessionKey: "agent:main:main",
      database,
    });
    if (!subject?.delegation || !subject.agentSession) {
      throw new Error("expected an authorized agent-session subject");
    }
    const runtime = createStateGatewayAuthorizationRuntime({ database });
    if (runtime.mode !== "isolated") {
      throw new Error("expected isolated authorization runtime");
    }
    const request = {
      principal: subject.principal,
      domain: subject.domain,
      delegation: subject.delegation,
      agentSession: subject.agentSession,
      method: "plugin-tool:workspaces.workspace_get",
      permission: "plugin.tool.read",
      resources: [agentSessionResource],
    } as const;

    await expect(runtime.authorize(request)).resolves.toMatchObject({ allowed: true });
    revokeAuthorizationPermission({
      domainId: "domain-1",
      resource: agentSessionResource,
      principalId: member.id,
      permission: GATEWAY_AGENT_SESSION_INVOKE_PERMISSION,
      revokedByPrincipalId: owner.id,
      database,
    });
    await expect(runtime.authorize(request)).resolves.toEqual({
      allowed: false,
      reason: "forbidden",
    });

    grantAuthorizationPermission({
      domainId: "domain-1",
      resource: agentSessionResource,
      principalId: member.id,
      permission: GATEWAY_AGENT_SESSION_INVOKE_PERMISSION,
      grantedByPrincipalId: owner.id,
      database,
    });
    await expect(runtime.authorize(request)).resolves.toMatchObject({ allowed: true });
    revokeAuthorizationAgentSessionBinding({
      domainId: "domain-1",
      id: "binding-1",
      revokedByPrincipalId: owner.id,
      database,
    });
    await expect(runtime.authorize(request)).resolves.toEqual({
      allowed: false,
      reason: "forbidden",
    });
  });

  it("fails closed after either the binding or delegation is revoked", () => {
    const bindingDatabase = createDatabase();
    seedDelegation(bindingDatabase);
    bindMainSession(bindingDatabase);
    revokeAuthorizationAgentSessionBinding({
      domainId: "domain-1",
      id: "binding-1",
      revokedByPrincipalId: owner.id,
      database: bindingDatabase,
    });
    expect(
      resolveGatewayAgentAuthorizationSubject({
        runtimeAgentId: "main",
        sessionKey: "agent:main:main",
        database: bindingDatabase,
      }),
    ).toBeUndefined();

    closeOpenClawStateDatabaseForTest();
    const delegationDatabase = createDatabase();
    seedDelegation(delegationDatabase);
    bindMainSession(delegationDatabase);
    revokeAuthorizationDelegation({
      domainId: "domain-1",
      delegationId: "delegation-1",
      revokedByPrincipalId: owner.id,
      database: delegationDatabase,
    });
    expect(
      openOpenClawStateDatabase(delegationDatabase)
        .db.prepare(
          `SELECT state, revoked_at
           FROM authorization_agent_session_bindings
           WHERE domain_id = ? AND binding_id = ?`,
        )
        .get("domain-1", "binding-1"),
    ).toMatchObject({ state: "revoked", revoked_at: expect.any(Number) });
    expect(
      resolveGatewayAgentAuthorizationSubject({
        runtimeAgentId: "main",
        sessionKey: "agent:main:main",
        database: delegationDatabase,
      }),
    ).toBeUndefined();
  });
});
