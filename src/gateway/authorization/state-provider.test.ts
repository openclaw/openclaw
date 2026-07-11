import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { GatewayResourceRef } from "./contracts.js";
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

function isolatedAuthorize(database: ReturnType<typeof createDatabase>) {
  const runtime = createStateGatewayAuthorizationRuntime({ database });
  if (runtime.mode !== "isolated") {
    throw new Error("expected isolated authorization runtime");
  }
  return runtime.authorize;
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

  it("rejects requests spanning more than one isolation domain", async () => {
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
    ).resolves.toEqual({ allowed: false, reason: "cross-domain" });
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
      isolatedAuthorize(database)({
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

  it("refuses to move an existing resource binding across domains", () => {
    const database = createDatabase();
    seedDomain({ database, resource: workspace });
    const secondOwner = {
      id: "principal-owner-2",
      principal: { issuer: "trusted-proxy", subject: "owner-2@example.com", kind: "human" },
    } as const;
    putAuthorizationPrincipal({ ...secondOwner, database });
    createIsolationDomain({ id: "domain-2", ownerPrincipalId: secondOwner.id, database });

    expect(() =>
      bindAuthorizationResource({
        domainId: "domain-2",
        resource: workspace,
        ownerPrincipalId: secondOwner.id,
        database,
      }),
    ).toThrow(/already bound/i);
  });

  it("does not allow non-human principals to become domain owners", () => {
    const database = createDatabase();
    const service = {
      id: "principal-service",
      principal: { issuer: "core", subject: "agent:main", kind: "service" },
    } as const;
    putAuthorizationPrincipal({ ...service, database });

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
      `INSERT INTO authorization_resources (
         namespace, resource_type, resource_id, domain_id, owner_principal_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(workspace.namespace, workspace.type, workspace.id, "domain-1", service.id, now);

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
             permission, granted_by_principal_id, granted_by_role, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "domain-1",
          secondOwner.id,
          workspace.namespace,
          workspace.type,
          workspace.id,
          "workspaces.workspace.read",
          owner.id,
          "owner",
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
             permission, granted_by_principal_id, granted_by_role, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          domainId,
          member.id,
          workspace.namespace,
          workspace.type,
          workspace.id,
          "workspaces.workspace.read",
          member.id,
          "owner",
          Date.now(),
        ),
    ).toThrow(/constraint|foreign key/i);
  });
});
