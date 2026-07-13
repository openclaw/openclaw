import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { GatewayAuthorizationRequest, GatewayResourceRef } from "./contracts.js";
import { createAuthorizationDelegation, revokeAuthorizationDelegation } from "./delegations.js";
import { createStateGatewayAuthorizationRuntime } from "./state-provider.js";
import {
  addIsolationDomainMember,
  bindAuthorizationResource,
  createIsolationDomain,
  grantAuthorizationPermission,
  putAuthorizationPrincipal,
} from "./state-store.js";

const tempDirs: string[] = [];

const owner = {
  id: "principal-owner",
  principal: { issuer: "trusted-proxy", subject: "owner@example.com", kind: "human" },
} as const;
const member = {
  id: "principal-member",
  principal: { issuer: "tailscale", subject: "member@example.com", kind: "human" },
} as const;
const recipient = {
  id: "principal-recipient",
  principal: { issuer: "trusted-proxy", subject: "recipient@example.com", kind: "human" },
} as const;
const agent = {
  id: "principal-agent",
  principal: { issuer: "core", subject: "agent:main", kind: "service" },
} as const;
const workspace: GatewayResourceRef = {
  namespace: "workspaces",
  type: "workspace",
  id: "workspace-1",
};
const tab: GatewayResourceRef = {
  namespace: "workspaces",
  type: "tab",
  id: "tab-1",
};

function createDatabase() {
  return { path: `${makeTempDir(tempDirs, "openclaw-rbac-")}/openclaw.sqlite` };
}

function isolatedAuthorize(database: ReturnType<typeof createDatabase>, domainId = "domain-1") {
  const runtime = createStateGatewayAuthorizationRuntime({ database });
  if (runtime.mode !== "isolated") {
    throw new Error("expected isolated authorization runtime");
  }
  return (request: Omit<GatewayAuthorizationRequest, "domain">) =>
    runtime.authorize({ ...request, domain: { id: domainId } });
}

function seedDomain(params: {
  database: ReturnType<typeof createDatabase>;
  domainId?: string;
  resource?: GatewayResourceRef;
}) {
  const domainId = params.domainId ?? "domain-1";
  putAuthorizationPrincipal({ ...owner, database: params.database });
  createIsolationDomain({ id: domainId, ownerPrincipalId: owner.id, database: params.database });
  if (params.resource) {
    bindAuthorizationResource({
      domainId,
      resource: params.resource,
      ownerPrincipalId: owner.id,
      database: params.database,
    });
  }
  return domainId;
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("state-backed gateway authorization", () => {
  it("requires and returns the exact active delegation for a service principal", async () => {
    const database = createDatabase();
    const domainId = seedDomain({ database, resource: workspace });
    putAuthorizationPrincipal({ ...agent, database });
    addIsolationDomainMember({
      domainId,
      principalId: agent.id,
      addedByPrincipalId: owner.id,
      database,
    });
    createAuthorizationDelegation({
      id: "delegation-1",
      assignmentId: "assignment-1",
      domainId,
      agentPrincipalId: agent.id,
      sponsorPrincipalId: owner.id,
      createdByPrincipalId: owner.id,
      database,
    });
    grantAuthorizationPermission({
      domainId,
      principalId: agent.id,
      resource: workspace,
      permission: "workspaces.workspace.read",
      grantedByPrincipalId: owner.id,
      database,
    });
    const request = {
      principal: agent.principal,
      delegation: { id: "delegation-1", assignmentId: "assignment-1" },
      method: "workspaces.get",
      permission: "workspaces.workspace.read",
      resources: [workspace],
    } as const;

    await expect(isolatedAuthorize(database)(request)).resolves.toEqual({
      allowed: true,
      principalId: agent.id,
      domain: { id: domainId },
      delegation: {
        id: "delegation-1",
        assignmentId: "assignment-1",
        sponsorPrincipalId: owner.id,
      },
    });
    await expect(
      isolatedAuthorize(database)({ ...request, delegation: undefined }),
    ).resolves.toEqual({ allowed: false, reason: "forbidden" });
    await expect(
      isolatedAuthorize(database)({
        ...request,
        delegation: { id: "delegation-1", assignmentId: "wrong-assignment" },
      }),
    ).resolves.toEqual({ allowed: false, reason: "forbidden" });

    revokeAuthorizationDelegation({
      domainId,
      delegationId: "delegation-1",
      revokedByPrincipalId: owner.id,
      database,
    });
    await expect(isolatedAuthorize(database)(request)).resolves.toEqual({
      allowed: false,
      reason: "forbidden",
    });
  });

  it("rejects an unmapped server-issued principal", async () => {
    const database = createDatabase();
    seedDomain({ database, resource: workspace });

    await expect(
      isolatedAuthorize(database)({
        principal: member.principal,
        method: "workspaces.get",
        permission: "workspaces.workspace.read",
        resources: [workspace],
      }),
    ).resolves.toEqual({ allowed: false, reason: "unknown-principal" });
  });

  it("matches the complete issuer, subject, and kind tuple", async () => {
    const database = createDatabase();
    seedDomain({ database, resource: workspace });

    await expect(
      isolatedAuthorize(database)({
        principal: { ...owner.principal, kind: "service" },
        method: "workspaces.get",
        permission: "workspaces.workspace.read",
        resources: [workspace],
      }),
    ).resolves.toEqual({ allowed: false, reason: "unknown-principal" });
  });

  it("rejects resources without a server-owned domain binding", async () => {
    const database = createDatabase();
    seedDomain({ database });

    await expect(
      isolatedAuthorize(database)({
        principal: owner.principal,
        method: "workspaces.get",
        permission: "workspaces.workspace.read",
        resources: [workspace],
      }),
    ).resolves.toEqual({ allowed: false, reason: "unbound-resource" });
  });

  it("does not resolve a resource outside the trusted request domain", async () => {
    const database = createDatabase();
    seedDomain({ database, domainId: "domain-1", resource: workspace });
    putAuthorizationPrincipal({ ...member, database });
    createIsolationDomain({ id: "domain-2", ownerPrincipalId: member.id, database });
    bindAuthorizationResource({
      domainId: "domain-2",
      resource: tab,
      ownerPrincipalId: member.id,
      database,
    });

    await expect(
      isolatedAuthorize(database)({
        principal: owner.principal,
        method: "workspaces.move",
        permission: "workspaces.tab.write",
        resources: [workspace, tab],
      }),
    ).resolves.toEqual({ allowed: false, reason: "unbound-resource" });
  });

  it("rejects a known principal that is not a member of the resource domain", async () => {
    const database = createDatabase();
    seedDomain({ database, resource: workspace });
    putAuthorizationPrincipal({ ...member, database });

    await expect(
      isolatedAuthorize(database)({
        principal: member.principal,
        method: "workspaces.get",
        permission: "workspaces.workspace.read",
        resources: [workspace],
      }),
    ).resolves.toEqual({ allowed: false, reason: "cross-domain" });
  });

  it("requires an exact grant for every resource", async () => {
    const database = createDatabase();
    const domainId = seedDomain({ database, resource: workspace });
    bindAuthorizationResource({
      domainId,
      resource: tab,
      ownerPrincipalId: owner.id,
      database,
    });
    putAuthorizationPrincipal({ ...member, database });
    addIsolationDomainMember({
      domainId,
      principalId: member.id,
      addedByPrincipalId: owner.id,
      database,
    });
    grantAuthorizationPermission({
      domainId,
      principalId: member.id,
      resource: workspace,
      permission: "workspaces.workspace.read",
      grantedByPrincipalId: owner.id,
      database,
    });

    await expect(
      isolatedAuthorize(database)({
        principal: member.principal,
        method: "workspaces.get",
        permission: "workspaces.workspace.read",
        resources: [workspace, tab],
      }),
    ).resolves.toEqual({ allowed: false, reason: "forbidden" });
  });

  it("allows a member with exact grants and returns the stable principal and domain", async () => {
    const database = createDatabase();
    const domainId = seedDomain({ database, resource: workspace });
    putAuthorizationPrincipal({ ...member, database });
    addIsolationDomainMember({
      domainId,
      principalId: member.id,
      addedByPrincipalId: owner.id,
      database,
    });
    grantAuthorizationPermission({
      domainId,
      principalId: member.id,
      resource: workspace,
      permission: "workspaces.workspace.read",
      grantedByPrincipalId: owner.id,
      database,
    });

    await expect(
      isolatedAuthorize(database)({
        principal: member.principal,
        method: "workspaces.get",
        permission: "workspaces.workspace.read",
        resources: [workspace, workspace],
      }),
    ).resolves.toEqual({
      allowed: true,
      principalId: member.id,
      domain: { id: domainId },
    });
  });

  it("allows the sole domain owner without materializing wildcard grants", async () => {
    const database = createDatabase();
    const domainId = seedDomain({ database, resource: workspace });

    await expect(
      isolatedAuthorize(database)({
        principal: owner.principal,
        method: "workspaces.share",
        permission: "workspaces.tab.share",
        resources: [workspace],
      }),
    ).resolves.toEqual({
      allowed: true,
      principalId: owner.id,
      domain: { id: domainId },
    });
  });

  it("allows a human resource owner without granting workspace-admin authority", async () => {
    const database = createDatabase();
    const domainId = seedDomain({ database, resource: workspace });
    putAuthorizationPrincipal({ ...member, database });
    addIsolationDomainMember({
      domainId,
      principalId: member.id,
      addedByPrincipalId: owner.id,
      database,
    });
    bindAuthorizationResource({
      domainId,
      resource: tab,
      ownerPrincipalId: member.id,
      database,
    });

    await expect(
      isolatedAuthorize(database)({
        principal: member.principal,
        method: "workspaces.share",
        permission: "workspaces.tab.share",
        resources: [tab],
      }),
    ).resolves.toEqual({
      allowed: true,
      principalId: member.id,
      domain: { id: domainId },
    });
    await expect(
      isolatedAuthorize(database)({
        principal: member.principal,
        method: "workspaces.replace",
        permission: "workspaces.workspace.replace",
        resources: [workspace],
      }),
    ).resolves.toEqual({ allowed: false, reason: "forbidden" });
  });

  it("lets a human resource owner grant exact access only on that resource", async () => {
    const database = createDatabase();
    const domainId = seedDomain({ database, resource: workspace });
    for (const entry of [member, recipient]) {
      putAuthorizationPrincipal({ ...entry, database });
      addIsolationDomainMember({
        domainId,
        principalId: entry.id,
        addedByPrincipalId: owner.id,
        database,
      });
    }
    bindAuthorizationResource({
      domainId,
      resource: tab,
      ownerPrincipalId: member.id,
      database,
    });

    expect(() =>
      grantAuthorizationPermission({
        domainId,
        principalId: recipient.id,
        resource: tab,
        permission: "workspaces.tab.read",
        grantedByPrincipalId: member.id,
        database,
      }),
    ).not.toThrow();
    expect(() =>
      grantAuthorizationPermission({
        domainId,
        principalId: recipient.id,
        resource: workspace,
        permission: "workspaces.workspace.read",
        grantedByPrincipalId: member.id,
        database,
      }),
    ).toThrow(/owner/i);
  });

  it("does not allow a service principal to own a resource", () => {
    const database = createDatabase();
    const domainId = seedDomain({ database });
    const service = {
      id: "principal-service",
      principal: { issuer: "core", subject: "agent:main", kind: "service" },
    } as const;
    putAuthorizationPrincipal({ ...service, database });
    addIsolationDomainMember({
      domainId,
      principalId: service.id,
      addedByPrincipalId: owner.id,
      database,
    });

    expect(() =>
      bindAuthorizationResource({
        domainId,
        resource: tab,
        ownerPrincipalId: service.id,
        database,
      }),
    ).toThrow(/human principal/i);
  });

  it("supports one principal holding non-owner membership in multiple domains", async () => {
    const database = createDatabase();
    const firstDomainId = seedDomain({ database, domainId: "domain-1", resource: workspace });
    const secondOwner = {
      id: "principal-owner-2",
      principal: { issuer: "tailscale", subject: "owner-2@example.com", kind: "human" },
    } as const;
    putAuthorizationPrincipal({ ...member, database });
    putAuthorizationPrincipal({ ...secondOwner, database });
    createIsolationDomain({ id: "domain-2", ownerPrincipalId: secondOwner.id, database });
    bindAuthorizationResource({
      domainId: "domain-2",
      resource: tab,
      ownerPrincipalId: secondOwner.id,
      database,
    });
    for (const [domainId, resource] of [
      [firstDomainId, workspace],
      ["domain-2", tab],
    ] as const) {
      addIsolationDomainMember({
        domainId,
        principalId: member.id,
        addedByPrincipalId: domainId === firstDomainId ? owner.id : secondOwner.id,
        database,
      });
      grantAuthorizationPermission({
        domainId,
        principalId: member.id,
        resource,
        permission: "workspaces.resource.read",
        grantedByPrincipalId: domainId === firstDomainId ? owner.id : secondOwner.id,
        database,
      });
    }

    await expect(
      isolatedAuthorize(
        database,
        "domain-2",
      )({
        principal: member.principal,
        method: "workspaces.get",
        permission: "workspaces.resource.read",
        resources: [tab],
      }),
    ).resolves.toEqual({
      allowed: true,
      principalId: member.id,
      domain: { id: "domain-2" },
    });
  });

  it("isolates identical opaque resource IDs in different domains", async () => {
    const database = createDatabase();
    seedDomain({ database, resource: workspace });
    const secondOwner = {
      id: "principal-owner-2",
      principal: { issuer: "trusted-proxy", subject: "owner-2@example.com", kind: "human" },
    } as const;
    putAuthorizationPrincipal({ ...secondOwner, database });
    createIsolationDomain({ id: "domain-2", ownerPrincipalId: secondOwner.id, database });

    bindAuthorizationResource({
      domainId: "domain-2",
      resource: workspace,
      ownerPrincipalId: secondOwner.id,
      database,
    });

    await expect(
      isolatedAuthorize(
        database,
        "domain-1",
      )({
        principal: owner.principal,
        method: "workspaces.get",
        permission: "workspaces.workspace.read",
        resources: [workspace],
      }),
    ).resolves.toMatchObject({
      allowed: true,
      principalId: owner.id,
      domain: { id: "domain-1" },
    });
    await expect(
      isolatedAuthorize(
        database,
        "domain-2",
      )({
        principal: secondOwner.principal,
        method: "workspaces.get",
        permission: "workspaces.workspace.read",
        resources: [workspace],
      }),
    ).resolves.toMatchObject({
      allowed: true,
      principalId: secondOwner.id,
      domain: { id: "domain-2" },
    });
  });

  it("does not reuse a same-ID grant across domains for a multi-domain member", async () => {
    const database = createDatabase();
    seedDomain({ database, domainId: "domain-1", resource: workspace });
    const secondOwner = {
      id: "principal-owner-2",
      principal: { issuer: "trusted-proxy", subject: "owner-2@example.com", kind: "human" },
    } as const;
    putAuthorizationPrincipal({ ...secondOwner, database });
    putAuthorizationPrincipal({ ...member, database });
    createIsolationDomain({ id: "domain-2", ownerPrincipalId: secondOwner.id, database });
    bindAuthorizationResource({
      domainId: "domain-2",
      resource: workspace,
      ownerPrincipalId: secondOwner.id,
      database,
    });
    for (const [domainId, addedByPrincipalId] of [
      ["domain-1", owner.id],
      ["domain-2", secondOwner.id],
    ] as const) {
      addIsolationDomainMember({
        domainId,
        principalId: member.id,
        addedByPrincipalId,
        database,
      });
    }
    grantAuthorizationPermission({
      domainId: "domain-1",
      principalId: member.id,
      resource: workspace,
      permission: "workspaces.workspace.read",
      grantedByPrincipalId: owner.id,
      database,
    });

    const request = {
      principal: member.principal,
      method: "workspaces.get",
      permission: "workspaces.workspace.read",
      resources: [workspace],
    } as const;
    await expect(isolatedAuthorize(database, "domain-1")(request)).resolves.toMatchObject({
      allowed: true,
      domain: { id: "domain-1" },
    });
    await expect(isolatedAuthorize(database, "domain-2")(request)).resolves.toEqual({
      allowed: false,
      reason: "forbidden",
    });
  });

  it("does not allow non-human principals to become domain owners", () => {
    const database = createDatabase();
    const service = {
      id: "principal-service",
      principal: { issuer: "core", subject: "agent:main", kind: "service" },
    } as const;
    putAuthorizationPrincipal({ ...service, database });
    putAuthorizationPrincipal({ ...owner, database });

    expect(() =>
      createIsolationDomain({
        id: "domain-1",
        ownerPrincipalId: service.id,
        database,
      }),
    ).toThrow(/human principal/i);
  });

  it("does not honor a non-human owner row if state was seeded outside the store API", async () => {
    const database = createDatabase();
    const service = {
      id: "principal-service",
      principal: { issuer: "core", subject: "agent:main", kind: "service" },
    } as const;
    putAuthorizationPrincipal({ ...service, database });
    putAuthorizationPrincipal({ ...owner, database });
    const { db } = openOpenClawStateDatabase(database);
    const now = Date.now();
    db.prepare(
      "INSERT INTO authorization_domains (domain_id, created_at, updated_at) VALUES (?, ?, ?)",
    ).run("domain-1", now, now);
    db.prepare(
      `INSERT INTO authorization_domain_memberships (
         domain_id, principal_id, role, added_by_principal_id, added_by_role, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("domain-1", service.id, "owner", service.id, "owner", now);
    db.prepare(
      `INSERT INTO authorization_domain_memberships (
         domain_id, principal_id, role, added_by_principal_id, added_by_role, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("domain-1", owner.id, "member", service.id, "owner", now);
    db.prepare(
      `INSERT INTO authorization_resources (
         namespace, resource_type, resource_id, domain_id, owner_principal_id,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(workspace.namespace, workspace.type, workspace.id, "domain-1", owner.id, now, now);

    await expect(
      isolatedAuthorize(database)({
        principal: service.principal,
        method: "workspaces.share",
        permission: "workspaces.tab.share",
        resources: [workspace],
      }),
    ).resolves.toEqual({ allowed: false, reason: "forbidden" });
  });

  it("adds the authorization tables to an existing state database without losing data", () => {
    const database = createDatabase();
    const sqlite = requireNodeSqlite();
    const legacy = new sqlite.DatabaseSync(database.path);
    legacy.exec("CREATE TABLE preserved_state (value TEXT NOT NULL)");
    legacy.prepare("INSERT INTO preserved_state (value) VALUES (?)").run("keep-me");
    legacy.close();

    const opened = openOpenClawStateDatabase(database);
    expect(
      opened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("authorization_grants"),
    ).toEqual({ name: "authorization_grants" });
    expect(opened.db.prepare("SELECT value FROM preserved_state").get()).toEqual({
      value: "keep-me",
    });
    closeOpenClawStateDatabaseForTest();
    expect(() => openOpenClawStateDatabase(database)).not.toThrow();
  });

  it("rejects a grant whose principal and resource belong to different domains", () => {
    const database = createDatabase();
    seedDomain({ database, domainId: "domain-1", resource: workspace });
    const secondOwner = {
      id: "principal-owner-2",
      principal: { issuer: "tailscale", subject: "owner-2@example.com", kind: "human" },
    } as const;
    putAuthorizationPrincipal({ ...secondOwner, database });
    createIsolationDomain({ id: "domain-2", ownerPrincipalId: secondOwner.id, database });
    const { db } = openOpenClawStateDatabase(database);

    expect(() =>
      db
        .prepare(
          `INSERT INTO authorization_grants (
             domain_id, principal_id, namespace, resource_type, resource_id,
             permission, granted_by_principal_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "domain-1",
          secondOwner.id,
          workspace.namespace,
          workspace.type,
          workspace.id,
          "workspaces.workspace.read",
          owner.id,
          Date.now(),
        ),
    ).toThrow(/foreign key/i);
  });

  it("rejects a grant authored by a non-owner member even outside the store API", () => {
    const database = createDatabase();
    const domainId = seedDomain({ database, resource: workspace });
    putAuthorizationPrincipal({ ...member, database });
    addIsolationDomainMember({
      domainId,
      principalId: member.id,
      addedByPrincipalId: owner.id,
      database,
    });
    const { db } = openOpenClawStateDatabase(database);

    expect(() =>
      db
        .prepare(
          `INSERT INTO authorization_grants (
             domain_id, principal_id, namespace, resource_type, resource_id,
             permission, granted_by_principal_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          domainId,
          member.id,
          workspace.namespace,
          workspace.type,
          workspace.id,
          "workspaces.workspace.read",
          member.id,
          Date.now(),
        ),
    ).toThrow(/constraint|foreign key|must own/i);
  });

  it("rejects moving an existing resource-owner grant to a resource they do not own", () => {
    const database = createDatabase();
    const domainId = seedDomain({ database, resource: workspace });
    for (const entry of [member, recipient]) {
      putAuthorizationPrincipal({ ...entry, database });
      addIsolationDomainMember({
        domainId,
        principalId: entry.id,
        addedByPrincipalId: owner.id,
        database,
      });
    }
    bindAuthorizationResource({
      domainId,
      resource: tab,
      ownerPrincipalId: member.id,
      database,
    });
    grantAuthorizationPermission({
      domainId,
      principalId: recipient.id,
      resource: tab,
      permission: "workspaces.tab.read",
      grantedByPrincipalId: member.id,
      database,
    });
    const { db } = openOpenClawStateDatabase(database);

    expect(() =>
      db
        .prepare(
          `UPDATE authorization_grants
           SET namespace = ?, resource_type = ?, resource_id = ?, permission = ?
           WHERE domain_id = ? AND principal_id = ?
             AND namespace = ? AND resource_type = ? AND resource_id = ? AND permission = ?`,
        )
        .run(
          workspace.namespace,
          workspace.type,
          workspace.id,
          "workspaces.workspace.read",
          domainId,
          recipient.id,
          tab.namespace,
          tab.type,
          tab.id,
          "workspaces.tab.read",
        ),
    ).toThrow(/immutable|must own/i);
  });
});
