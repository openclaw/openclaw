import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createIsolationDomain, putAuthorizationPrincipal } from "./state-store.js";
import { bootstrapTeamsOwner } from "./teams-bootstrap.js";
import { authenticateTeamsLocalAccount } from "./teams-identity.js";

const tempDirs: string[] = [];

function createDatabase() {
  return { path: `${makeTempDir(tempDirs, "openclaw-teams-bootstrap-")}/openclaw.sqlite` };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("Teams first-owner bootstrap", () => {
  it("atomically creates one local human owner with the initial workspace resources", async () => {
    const database = createDatabase();

    const bootstrap = await bootstrapTeamsOwner({
      loginLabel: " Owner@Example.com ",
      password: "correct horse battery staple",
      domainId: "domain-local",
      now: 10_000,
      database,
    });

    expect(bootstrap).toEqual({
      account: {
        id: expect.any(String),
        principalId: expect.any(String),
        loginLabel: "owner@example.com",
        createdAt: 10_000,
      },
      agent: {
        principalId: expect.any(String),
        runtimeAgentId: "main",
        sessionKey: "agent:main:main",
        assignmentId: "main:main",
      },
      domainId: "domain-local",
    });
    await expect(
      authenticateTeamsLocalAccount({
        loginLabel: "OWNER@example.com",
        password: "correct horse battery staple",
        database,
      }),
    ).resolves.toEqual(bootstrap.account);

    const { db } = openOpenClawStateDatabase(database);
    expect(
      db
        .prepare(
          `SELECT issuer, subject, kind
             FROM authorization_principals
            WHERE principal_id = ?`,
        )
        .get(bootstrap.account.principalId),
    ).toEqual({ issuer: "openclaw-local", subject: "owner@example.com", kind: "human" });
    expect(
      db
        .prepare(
          `SELECT issuer, subject, kind
             FROM authorization_principals
            WHERE principal_id = ?`,
        )
        .get(bootstrap.agent.principalId),
    ).toEqual({ issuer: "openclaw-core", subject: "agent:main", kind: "service" });
    expect(
      db
        .prepare(
          `SELECT role, added_by_principal_id, added_by_role
             FROM authorization_domain_memberships
            WHERE domain_id = ? AND principal_id = ?`,
        )
        .get(bootstrap.domainId, bootstrap.account.principalId),
    ).toEqual({
      role: "owner",
      added_by_principal_id: bootstrap.account.principalId,
      added_by_role: "owner",
    });
    expect(
      db
        .prepare(
          `SELECT role, added_by_principal_id, added_by_role
             FROM authorization_domain_memberships
            WHERE domain_id = ? AND principal_id = ?`,
        )
        .get(bootstrap.domainId, bootstrap.agent.principalId),
    ).toEqual({
      role: "member",
      added_by_principal_id: bootstrap.account.principalId,
      added_by_role: "owner",
    });
    expect(
      db
        .prepare(
          `SELECT namespace, resource_type, resource_id, owner_principal_id,
                  parent_namespace, parent_resource_type, parent_resource_id
             FROM authorization_resources
            WHERE domain_id = ?
            ORDER BY resource_type`,
        )
        .all(bootstrap.domainId),
    ).toEqual([
      {
        namespace: "core",
        resource_type: "agent-session",
        resource_id: "main:main",
        owner_principal_id: bootstrap.account.principalId,
        parent_namespace: null,
        parent_resource_type: null,
        parent_resource_id: null,
      },
      {
        namespace: "workspaces",
        resource_type: "tab",
        resource_id: "main",
        owner_principal_id: bootstrap.account.principalId,
        parent_namespace: "workspaces",
        parent_resource_type: "workspace",
        parent_resource_id: "default",
      },
      {
        namespace: "workspaces",
        resource_type: "workspace",
        resource_id: "default",
        owner_principal_id: bootstrap.account.principalId,
        parent_namespace: null,
        parent_resource_type: null,
        parent_resource_id: null,
      },
    ]);
    expect(
      db
        .prepare(
          `SELECT delegation_id, assignment_id, agent_principal_id, sponsor_principal_id, state
             FROM authorization_delegations
            WHERE domain_id = ?`,
        )
        .get(bootstrap.domainId),
    ).toEqual({
      delegation_id: "main:main",
      assignment_id: "main:main",
      agent_principal_id: bootstrap.agent.principalId,
      sponsor_principal_id: bootstrap.account.principalId,
      state: "active",
    });
    expect(
      db
        .prepare(
          `SELECT binding_id, runtime_agent_id, session_key, assignment_id, state
             FROM authorization_agent_session_bindings
            WHERE domain_id = ?`,
        )
        .get(bootstrap.domainId),
    ).toEqual({
      binding_id: "main:main",
      runtime_agent_id: "main",
      session_key: "agent:main:main",
      assignment_id: "main:main",
      state: "active",
    });
    expect(
      db
        .prepare(
          `SELECT namespace, resource_type, resource_id, permission
             FROM authorization_grants
            WHERE domain_id = ? AND principal_id = ?
            ORDER BY resource_type, permission`,
        )
        .all(bootstrap.domainId, bootstrap.agent.principalId),
    ).toEqual([
      {
        namespace: "workspaces",
        resource_type: "tab",
        resource_id: "main",
        permission: "workspaces.tab.changeRequest.create",
      },
      {
        namespace: "workspaces",
        resource_type: "tab",
        resource_id: "main",
        permission: "workspaces.tab.read",
      },
      {
        namespace: "workspaces",
        resource_type: "tab",
        resource_id: "main",
        permission: "workspaces.tab.write",
      },
      {
        namespace: "workspaces",
        resource_type: "workspace",
        resource_id: "default",
        permission: "workspaces.workspace.read",
      },
    ]);
  });

  it("returns the same complete owner without replacing its password", async () => {
    const database = createDatabase();
    const first = await bootstrapTeamsOwner({
      loginLabel: "owner@example.com",
      password: "correct horse battery staple",
      domainId: "domain-local",
      now: 10_000,
      database,
    });
    const { db } = openOpenClawStateDatabase(database);
    const before = db
      .prepare(
        `SELECT password_salt, password_verifier
           FROM teams_local_accounts
          WHERE account_id = ?`,
      )
      .get(first.account.id) as { password_salt: Uint8Array; password_verifier: Uint8Array };

    await expect(
      bootstrapTeamsOwner({
        loginLabel: " OWNER@EXAMPLE.COM ",
        password: "a different valid password",
        domainId: "domain-local",
        now: 20_000,
        database,
      }),
    ).resolves.toEqual(first);

    const after = db
      .prepare(
        `SELECT password_salt, password_verifier
           FROM teams_local_accounts
          WHERE account_id = ?`,
      )
      .get(first.account.id) as { password_salt: Uint8Array; password_verifier: Uint8Array };
    expect(Buffer.from(after.password_salt)).toEqual(Buffer.from(before.password_salt));
    expect(Buffer.from(after.password_verifier)).toEqual(Buffer.from(before.password_verifier));
    await expect(
      authenticateTeamsLocalAccount({
        loginLabel: "owner@example.com",
        password: "correct horse battery staple",
        database,
      }),
    ).resolves.toEqual(first.account);
  });

  it("rejects a mismatched existing domain without creating an account or principal", async () => {
    const database = createDatabase();
    putAuthorizationPrincipal({
      id: "other-owner",
      principal: { issuer: "openclaw-local", subject: "other@example.com", kind: "human" },
      database,
    });
    createIsolationDomain({ id: "domain-local", ownerPrincipalId: "other-owner", database });

    await expect(
      bootstrapTeamsOwner({
        loginLabel: "owner@example.com",
        password: "correct horse battery staple",
        domainId: "domain-local",
        database,
      }),
    ).rejects.toThrow(/already belongs to another owner/i);

    const { db } = openOpenClawStateDatabase(database);
    expect(db.prepare("SELECT COUNT(*) AS count FROM teams_local_accounts").get()).toEqual({
      count: 0,
    });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM authorization_principals WHERE issuer = ?")
        .get("openclaw-local"),
    ).toEqual({ count: 1 });
  });
});
