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
  listAuthorizedResources,
  putAuthorizationPrincipal,
  removeIsolationDomainMember,
  retireAuthorizationResource,
  revokeAuthorizationPermission,
  transferAuthorizationResourceOwner,
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
const service = {
  id: "principal-service",
  principal: { issuer: "core", subject: "agent:main", kind: "service" },
} as const;

const workspace: GatewayResourceRef = {
  namespace: "workspaces",
  type: "workspace",
  id: "workspace-1",
};
const tabOne: GatewayResourceRef = {
  namespace: "workspaces",
  type: "tab",
  id: "tab-1",
};
const tabTwo: GatewayResourceRef = {
  namespace: "workspaces",
  type: "tab",
  id: "tab-2",
};

function createDatabase() {
  return { path: `${makeTempDir(tempDirs, "openclaw-rbac-lifecycle-")}/openclaw.sqlite` };
}

function seedDomain(database: ReturnType<typeof createDatabase>, domainId = "domain-1") {
  putAuthorizationPrincipal({ ...owner, database });
  createIsolationDomain({ id: domainId, ownerPrincipalId: owner.id, database });
  bindAuthorizationResource({
    domainId,
    resource: workspace,
    ownerPrincipalId: owner.id,
    database,
  });
  return domainId;
}

function addMember(
  database: ReturnType<typeof createDatabase>,
  domainId: string,
  entry: typeof member | typeof recipient | typeof service,
) {
  putAuthorizationPrincipal({ ...entry, database });
  addIsolationDomainMember({
    domainId,
    principalId: entry.id,
    addedByPrincipalId: owner.id,
    database,
  });
}

function isolatedAuthorize(database: ReturnType<typeof createDatabase>) {
  const runtime = createStateGatewayAuthorizationRuntime({ database });
  if (runtime.mode !== "isolated") {
    throw new Error("expected isolated authorization runtime");
  }
  return runtime.authorize;
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("authorization state lifecycle", () => {
  it("binds an active parent and rejects missing or cross-domain parents", () => {
    const database = createDatabase();
    const domainId = seedDomain(database);
    bindAuthorizationResource({
      domainId,
      resource: tabOne,
      parent: workspace,
      ownerPrincipalId: owner.id,
      database,
    });
    const { db } = openOpenClawStateDatabase(database);
    expect(
      db
        .prepare(
          `SELECT parent_namespace, parent_resource_type, parent_resource_id
           FROM authorization_resources
           WHERE namespace = ? AND resource_type = ? AND resource_id = ?`,
        )
        .get(tabOne.namespace, tabOne.type, tabOne.id),
    ).toEqual({
      parent_namespace: workspace.namespace,
      parent_resource_type: workspace.type,
      parent_resource_id: workspace.id,
    });

    expect(() =>
      bindAuthorizationResource({
        domainId,
        resource: tabTwo,
        parent: { ...workspace, id: "missing-workspace" },
        ownerPrincipalId: owner.id,
        database,
      }),
    ).toThrow(/parent/i);

    const otherOwner = {
      id: "principal-other-owner",
      principal: { issuer: "trusted-proxy", subject: "other@example.com", kind: "human" },
    } as const;
    putAuthorizationPrincipal({ ...otherOwner, database });
    createIsolationDomain({ id: "domain-2", ownerPrincipalId: otherOwner.id, database });
    const otherWorkspace = { ...workspace, id: "workspace-2" };
    bindAuthorizationResource({
      domainId: "domain-2",
      resource: otherWorkspace,
      ownerPrincipalId: otherOwner.id,
      database,
    });
    expect(() =>
      bindAuthorizationResource({
        domainId,
        resource: tabTwo,
        parent: otherWorkspace,
        ownerPrincipalId: owner.id,
        database,
      }),
    ).toThrow(/parent/i);
  });

  it("retires children before parents and makes retired resources unresolvable", async () => {
    const database = createDatabase();
    const domainId = seedDomain(database);
    bindAuthorizationResource({
      domainId,
      resource: tabOne,
      parent: workspace,
      ownerPrincipalId: owner.id,
      database,
    });

    expect(() =>
      retireAuthorizationResource({
        domainId,
        resource: workspace,
        retiredByPrincipalId: owner.id,
        database,
      }),
    ).toThrow(/active child/i);
    retireAuthorizationResource({
      domainId,
      resource: tabOne,
      retiredByPrincipalId: owner.id,
      database,
    });
    expect(() =>
      retireAuthorizationResource({
        domainId,
        resource: tabOne,
        retiredByPrincipalId: owner.id,
        database,
      }),
    ).not.toThrow();

    await expect(
      isolatedAuthorize(database)({
        principal: owner.principal,
        method: "workspaces.get",
        permission: "workspaces.tab.read",
        resources: [tabOne],
      }),
    ).resolves.toEqual({ allowed: false, reason: "unbound-resource" });
    retireAuthorizationResource({
      domainId,
      resource: workspace,
      retiredByPrincipalId: owner.id,
      database,
    });
  });

  it("revokes one exact permission idempotently", async () => {
    const database = createDatabase();
    const domainId = seedDomain(database);
    addMember(database, domainId, member);
    grantAuthorizationPermission({
      domainId,
      principalId: member.id,
      resource: workspace,
      permission: "workspaces.workspace.read",
      grantedByPrincipalId: owner.id,
      database,
    });
    revokeAuthorizationPermission({
      domainId,
      principalId: member.id,
      resource: workspace,
      permission: "workspaces.workspace.read",
      revokedByPrincipalId: owner.id,
      database,
    });
    expect(() =>
      revokeAuthorizationPermission({
        domainId,
        principalId: member.id,
        resource: workspace,
        permission: "workspaces.workspace.read",
        revokedByPrincipalId: owner.id,
        database,
      }),
    ).not.toThrow();

    await expect(
      isolatedAuthorize(database)({
        principal: member.principal,
        method: "workspaces.get",
        permission: "workspaces.workspace.read",
        resources: [workspace],
      }),
    ).resolves.toEqual({ allowed: false, reason: "forbidden" });
  });

  it("transfers exact resource ownership without transferring domain administration", async () => {
    const database = createDatabase();
    const domainId = seedDomain(database);
    addMember(database, domainId, member);
    addMember(database, domainId, recipient);
    bindAuthorizationResource({
      domainId,
      resource: tabOne,
      parent: workspace,
      ownerPrincipalId: member.id,
      database,
    });
    transferAuthorizationResourceOwner({
      domainId,
      resource: tabOne,
      transferredByPrincipalId: member.id,
      newOwnerPrincipalId: recipient.id,
      database,
    });

    await expect(
      isolatedAuthorize(database)({
        principal: member.principal,
        method: "workspaces.share",
        permission: "workspaces.tab.share",
        resources: [tabOne],
      }),
    ).resolves.toEqual({ allowed: false, reason: "forbidden" });
    await expect(
      isolatedAuthorize(database)({
        principal: recipient.principal,
        method: "workspaces.share",
        permission: "workspaces.tab.share",
        resources: [tabOne],
      }),
    ).resolves.toEqual({
      allowed: true,
      principalId: recipient.id,
      domain: { id: domainId },
    });
    await expect(
      isolatedAuthorize(database)({
        principal: recipient.principal,
        method: "workspaces.replace",
        permission: "workspaces.workspace.replace",
        resources: [workspace],
      }),
    ).resolves.toEqual({ allowed: false, reason: "forbidden" });
  });

  it("blocks member removal while active resources would be orphaned", () => {
    const database = createDatabase();
    const domainId = seedDomain(database);
    addMember(database, domainId, member);
    addMember(database, domainId, recipient);
    bindAuthorizationResource({
      domainId,
      resource: tabOne,
      parent: workspace,
      ownerPrincipalId: member.id,
      database,
    });
    expect(() =>
      removeIsolationDomainMember({
        domainId,
        principalId: member.id,
        removedByPrincipalId: owner.id,
        database,
      }),
    ).toThrow(/owns active resource/i);

    transferAuthorizationResourceOwner({
      domainId,
      resource: tabOne,
      transferredByPrincipalId: owner.id,
      newOwnerPrincipalId: recipient.id,
      database,
    });
    removeIsolationDomainMember({
      domainId,
      principalId: member.id,
      removedByPrincipalId: owner.id,
      database,
    });
    const { db } = openOpenClawStateDatabase(database);
    expect(
      db
        .prepare(
          "SELECT 1 AS present FROM authorization_domain_memberships WHERE domain_id = ? AND principal_id = ?",
        )
        .get(domainId, member.id),
    ).toBeUndefined();
  });

  it("lists only active exact resources with stable cursor pagination", () => {
    const database = createDatabase();
    const domainId = seedDomain(database);
    addMember(database, domainId, member);
    addMember(database, domainId, service);
    bindAuthorizationResource({
      domainId,
      resource: tabOne,
      parent: workspace,
      ownerPrincipalId: member.id,
      database,
    });
    bindAuthorizationResource({
      domainId,
      resource: tabTwo,
      parent: workspace,
      ownerPrincipalId: owner.id,
      database,
    });
    for (const principalId of [member.id, service.id]) {
      grantAuthorizationPermission({
        domainId,
        principalId,
        resource: tabTwo,
        permission: "workspaces.tab.read",
        grantedByPrincipalId: owner.id,
        database,
      });
    }

    const first = listAuthorizedResources({
      domainId,
      principalId: member.id,
      namespace: "workspaces",
      type: "tab",
      permission: "workspaces.tab.read",
      limit: 1,
      database,
    });
    expect(first).toEqual({ resources: [tabOne], nextCursor: tabOne.id });
    expect(
      listAuthorizedResources({
        domainId,
        principalId: member.id,
        namespace: "workspaces",
        type: "tab",
        permission: "workspaces.tab.read",
        cursor: first.nextCursor,
        limit: 1,
        database,
      }),
    ).toEqual({ resources: [tabTwo] });
    expect(
      listAuthorizedResources({
        domainId,
        principalId: service.id,
        namespace: "workspaces",
        type: "tab",
        permission: "workspaces.tab.read",
        limit: 10,
        database,
      }),
    ).toEqual({ resources: [tabTwo] });

    retireAuthorizationResource({
      domainId,
      resource: tabTwo,
      retiredByPrincipalId: owner.id,
      database,
    });
    expect(
      listAuthorizedResources({
        domainId,
        principalId: member.id,
        namespace: "workspaces",
        type: "tab",
        permission: "workspaces.tab.read",
        limit: 10,
        database,
      }),
    ).toEqual({ resources: [tabOne] });
  });

  it("keeps resource identity and domain binding immutable outside the store API", () => {
    const database = createDatabase();
    seedDomain(database);
    const { db } = openOpenClawStateDatabase(database);

    expect(() =>
      db
        .prepare(
          `UPDATE authorization_resources
           SET resource_id = ?
           WHERE namespace = ? AND resource_type = ? AND resource_id = ?`,
        )
        .run("workspace-moved", workspace.namespace, workspace.type, workspace.id),
    ).toThrow(/immutable/i);
    expect(() =>
      db
        .prepare(
          `DELETE FROM authorization_resources
           WHERE namespace = ? AND resource_type = ? AND resource_id = ?`,
        )
        .run(workspace.namespace, workspace.type, workspace.id),
    ).toThrow(/retire|delete/i);
  });

  it("does not allow retired resource IDs to be reactivated", () => {
    const database = createDatabase();
    const domainId = seedDomain(database);
    retireAuthorizationResource({
      domainId,
      resource: workspace,
      retiredByPrincipalId: owner.id,
      database,
    });
    const { db } = openOpenClawStateDatabase(database);

    expect(() =>
      db
        .prepare(
          `UPDATE authorization_resources
           SET retired_at = NULL
           WHERE namespace = ? AND resource_type = ? AND resource_id = ?`,
        )
        .run(workspace.namespace, workspace.type, workspace.id),
    ).toThrow(/retired|reactivat/i);
  });

  it("does not allow raw retirement while an active child remains", () => {
    const database = createDatabase();
    const domainId = seedDomain(database);
    bindAuthorizationResource({
      domainId,
      resource: tabOne,
      parent: workspace,
      ownerPrincipalId: owner.id,
      database,
    });
    const { db } = openOpenClawStateDatabase(database);

    expect(() =>
      db
        .prepare(
          `UPDATE authorization_resources
           SET retired_at = ?
           WHERE namespace = ? AND resource_type = ? AND resource_id = ?`,
        )
        .run(Date.now(), workspace.namespace, workspace.type, workspace.id),
    ).toThrow(/active child/i);
  });

  it("rejects assigning resource ownership to a non-human member outside the store API", () => {
    const database = createDatabase();
    const domainId = seedDomain(database);
    addMember(database, domainId, service);
    const { db } = openOpenClawStateDatabase(database);

    expect(() =>
      db
        .prepare(
          `UPDATE authorization_resources
           SET owner_principal_id = ?
           WHERE namespace = ? AND resource_type = ? AND resource_id = ?`,
        )
        .run(service.id, workspace.namespace, workspace.type, workspace.id),
    ).toThrow(/human/i);
  });

  it("upgrades the prior resource table additively and installs lifecycle guards", () => {
    const database = createDatabase();
    const sqlite = requireNodeSqlite();
    const legacy = new sqlite.DatabaseSync(database.path);
    legacy.exec(`
      CREATE TABLE authorization_resources (
        namespace TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        domain_id TEXT NOT NULL,
        owner_principal_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, resource_type, resource_id),
        UNIQUE (domain_id, namespace, resource_type, resource_id)
      );
    `);
    legacy
      .prepare(
        `INSERT INTO authorization_resources (
           namespace, resource_type, resource_id, domain_id, owner_principal_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(workspace.namespace, workspace.type, workspace.id, "domain-1", owner.id, 1);
    legacy.close();

    const { db } = openOpenClawStateDatabase(database);
    const columns = db.prepare("PRAGMA table_info(authorization_resources)").all() as Array<{
      name?: unknown;
    }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "parent_namespace",
        "parent_resource_type",
        "parent_resource_id",
        "retired_at",
        "updated_at",
      ]),
    );
    expect(() =>
      db
        .prepare(
          `UPDATE authorization_resources
           SET resource_id = ?
           WHERE namespace = ? AND resource_type = ? AND resource_id = ?`,
        )
        .run("workspace-moved", workspace.namespace, workspace.type, workspace.id),
    ).toThrow(/immutable/i);
    expect(() =>
      db
        .prepare(
          `DELETE FROM authorization_resources
           WHERE namespace = ? AND resource_type = ? AND resource_id = ?`,
        )
        .run(workspace.namespace, workspace.type, workspace.id),
    ).toThrow(/retire|delete/i);
  });
});
