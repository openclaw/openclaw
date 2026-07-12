import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { GatewayResourceRef } from "./contracts.js";
import {
  bindAuthorizationResource,
  createIsolationDomain,
  putAuthorizationPrincipal,
  retireAuthorizationResource,
} from "./state-store.js";
import { resolveTeamsSession } from "./teams-identity.js";
import {
  createTeamsInvite,
  listTeamsInvites,
  redeemTeamsInvite,
  registerTeamsLocalAccountFromInvite,
  revokeTeamsInvite,
} from "./teams-invites.js";

const tempDirs: string[] = [];
const owner = {
  id: "principal-owner",
  principal: { issuer: "local", subject: "owner", kind: "human" },
} as const;
const recipient = {
  id: "principal-recipient",
  principal: { issuer: "local", subject: "recipient", kind: "human" },
} as const;
const workspace: GatewayResourceRef = {
  namespace: "workspaces",
  type: "workspace",
  id: "workspace-1",
};
const tab: GatewayResourceRef = { namespace: "workspaces", type: "tab", id: "tab-1" };

function createDatabase() {
  return { path: `${makeTempDir(tempDirs, "openclaw-teams-invite-")}/openclaw.sqlite` };
}

function seed(database: ReturnType<typeof createDatabase>) {
  putAuthorizationPrincipal({ ...owner, database });
  putAuthorizationPrincipal({ ...recipient, database });
  createIsolationDomain({ id: "domain-1", ownerPrincipalId: owner.id, database });
  bindAuthorizationResource({
    domainId: "domain-1",
    resource: workspace,
    ownerPrincipalId: owner.id,
    database,
  });
  bindAuthorizationResource({
    domainId: "domain-1",
    resource: tab,
    parent: workspace,
    ownerPrincipalId: owner.id,
    database,
  });
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("Teams one-time invites", () => {
  it("stores only a code digest and lists an exact safe grant manifest", () => {
    const database = createDatabase();
    seed(database);
    const created = createTeamsInvite({
      id: "invite-1",
      domainId: "domain-1",
      createdByPrincipalId: owner.id,
      recipientLabel: "  teammate@example.com ",
      ttlMs: 60_000,
      grants: [
        { resource: tab, permission: "workspaces.tab.read" },
        { resource: tab, permission: "workspaces.tab.request-changes" },
      ],
      database,
    });

    expect(created.code).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(created.invite).toEqual({
      id: "invite-1",
      domainId: "domain-1",
      createdByPrincipalId: owner.id,
      recipientLabel: "teammate@example.com",
      state: "active",
      createdAt: expect.any(Number),
      expiresAt: expect.any(Number),
      redeemedAt: null,
      redeemedByPrincipalId: null,
      revokedAt: null,
      grants: [
        { resource: tab, permission: "workspaces.tab.read" },
        { resource: tab, permission: "workspaces.tab.request-changes" },
      ],
    });
    expect(
      listTeamsInvites({ domainId: "domain-1", requestedByPrincipalId: owner.id, database }),
    ).toEqual([created.invite]);
    expect(JSON.stringify(created.invite)).not.toContain(created.code);

    const { db } = openOpenClawStateDatabase(database);
    const row = db
      .prepare("SELECT code_digest FROM teams_invites WHERE invite_id = ?")
      .get(created.invite.id) as { code_digest: string };
    expect(row.code_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(row.code_digest).not.toBe(created.code);
  });

  it("requires a current human domain owner and active exact resources", () => {
    const database = createDatabase();
    seed(database);
    expect(() =>
      createTeamsInvite({
        domainId: "domain-1",
        createdByPrincipalId: recipient.id,
        ttlMs: 60_000,
        grants: [{ resource: tab, permission: "workspaces.tab.read" }],
        database,
      }),
    ).toThrow(/domain owner/i);
    expect(() =>
      createTeamsInvite({
        domainId: "domain-1",
        createdByPrincipalId: owner.id,
        ttlMs: 60_000,
        grants: [{ resource: { ...tab, id: "missing-tab" }, permission: "workspaces.tab.read" }],
        database,
      }),
    ).toThrow(/active resource/i);
  });

  it("atomically redeems once into membership and exact grants", () => {
    const database = createDatabase();
    seed(database);
    const created = createTeamsInvite({
      id: "invite-1",
      domainId: "domain-1",
      createdByPrincipalId: owner.id,
      ttlMs: 60_000,
      now: 10_000,
      grants: [{ resource: tab, permission: "workspaces.tab.read" }],
      database,
    });

    const redeemed = redeemTeamsInvite({
      code: created.code,
      principalId: recipient.id,
      now: 20_000,
      database,
    });
    expect(redeemed).toMatchObject({
      id: "invite-1",
      state: "redeemed",
      redeemedAt: 20_000,
      redeemedByPrincipalId: recipient.id,
    });

    const { db } = openOpenClawStateDatabase(database);
    expect(
      db
        .prepare(
          "SELECT role FROM authorization_domain_memberships WHERE domain_id = ? AND principal_id = ?",
        )
        .get("domain-1", recipient.id),
    ).toEqual({ role: "member" });
    expect(
      db
        .prepare(
          `SELECT permission FROM authorization_grants
            WHERE domain_id = ? AND principal_id = ? AND namespace = ? AND resource_type = ? AND resource_id = ?`,
        )
        .all("domain-1", recipient.id, tab.namespace, tab.type, tab.id),
    ).toEqual([{ permission: "workspaces.tab.read" }]);
  });

  it("atomically registers a local account, redeems its invite, and issues the domain session", async () => {
    const database = createDatabase();
    seed(database);
    const created = createTeamsInvite({
      id: "invite-registration",
      domainId: "domain-1",
      createdByPrincipalId: owner.id,
      ttlMs: 60_000,
      now: 10_000,
      grants: [{ resource: tab, permission: "workspaces.tab.read" }],
      database,
    });

    const registration = await registerTeamsLocalAccountFromInvite({
      code: created.code,
      accountId: "account-new",
      principalId: "principal-new",
      loginLabel: " New.User@Example.com ",
      password: "correct horse battery staple",
      sessionTtlMs: 60_000,
      now: 20_000,
      database,
    });

    expect(registration.account).toEqual({
      id: "account-new",
      principalId: "principal-new",
      loginLabel: "new.user@example.com",
      createdAt: 20_000,
    });
    expect(registration.invite).toMatchObject({
      id: "invite-registration",
      state: "redeemed",
      redeemedByPrincipalId: "principal-new",
    });
    expect(registration.session.session).toMatchObject({
      accountId: "account-new",
      principalId: "principal-new",
      principal: {
        issuer: "openclaw-local",
        subject: "new.user@example.com",
        kind: "human",
      },
      domainId: "domain-1",
    });
    expect(
      resolveTeamsSession({ token: registration.session.token, now: 20_001, database }),
    ).toEqual(registration.session.session);
  });

  it("leaves no principal or account when invite registration is invalid or loses redemption", async () => {
    const database = createDatabase();
    seed(database);
    await expect(
      registerTeamsLocalAccountFromInvite({
        code: "unknown-code",
        accountId: "account-invalid",
        principalId: "principal-invalid",
        loginLabel: "invalid@example.com",
        password: "correct horse battery staple",
        sessionTtlMs: 60_000,
        database,
      }),
    ).rejects.toThrow("invite is invalid or unavailable");

    const created = createTeamsInvite({
      id: "invite-race",
      domainId: "domain-1",
      createdByPrincipalId: owner.id,
      ttlMs: 60_000,
      grants: [{ resource: tab, permission: "workspaces.tab.read" }],
      database,
    });
    const results = await Promise.allSettled([
      registerTeamsLocalAccountFromInvite({
        code: created.code,
        accountId: "account-contender-1",
        principalId: "principal-contender-1",
        loginLabel: "contender-1@example.com",
        password: "correct horse battery staple",
        sessionTtlMs: 60_000,
        database,
      }),
      registerTeamsLocalAccountFromInvite({
        code: created.code,
        accountId: "account-contender-2",
        principalId: "principal-contender-2",
        loginLabel: "contender-2@example.com",
        password: "correct horse battery staple",
        sessionTtlMs: 60_000,
        database,
      }),
    ]);
    expect(results.map((result) => result.status).toSorted()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.reason).toEqual(new Error("invite is invalid or unavailable"));

    const { db } = openOpenClawStateDatabase(database);
    expect(
      db
        .prepare("SELECT principal_id FROM authorization_principals WHERE principal_id IN (?, ?)")
        .all("principal-contender-1", "principal-contender-2"),
    ).toHaveLength(1);
    expect(
      db
        .prepare("SELECT account_id FROM teams_local_accounts WHERE account_id IN (?, ?)")
        .all("account-contender-1", "account-contender-2"),
    ).toHaveLength(1);
    expect(
      db
        .prepare("SELECT 1 AS found FROM authorization_principals WHERE principal_id = ?")
        .get("principal-invalid"),
    ).toBeUndefined();
    expect(
      db
        .prepare("SELECT 1 AS found FROM teams_local_accounts WHERE account_id = ?")
        .get("account-invalid"),
    ).toBeUndefined();
  });

  it("uses one generic failure for replay, expiry, revocation, and unknown codes", () => {
    const database = createDatabase();
    seed(database);
    const replay = createTeamsInvite({
      domainId: "domain-1",
      createdByPrincipalId: owner.id,
      ttlMs: 60_000,
      now: 10_000,
      grants: [{ resource: tab, permission: "workspaces.tab.read" }],
      database,
    });
    redeemTeamsInvite({ code: replay.code, principalId: recipient.id, now: 20_000, database });

    const expired = createTeamsInvite({
      domainId: "domain-1",
      createdByPrincipalId: owner.id,
      ttlMs: 60_000,
      now: 30_000,
      grants: [{ resource: tab, permission: "workspaces.tab.read" }],
      database,
    });
    const revoked = createTeamsInvite({
      domainId: "domain-1",
      createdByPrincipalId: owner.id,
      ttlMs: 60_000,
      now: 40_000,
      grants: [{ resource: tab, permission: "workspaces.tab.read" }],
      database,
    });
    revokeTeamsInvite({
      id: revoked.invite.id,
      domainId: "domain-1",
      revokedByPrincipalId: owner.id,
      now: 45_000,
      database,
    });

    const messages = [
      () =>
        redeemTeamsInvite({ code: replay.code, principalId: recipient.id, now: 50_000, database }),
      () =>
        redeemTeamsInvite({ code: expired.code, principalId: recipient.id, now: 90_000, database }),
      () =>
        redeemTeamsInvite({ code: revoked.code, principalId: recipient.id, now: 50_000, database }),
      () =>
        redeemTeamsInvite({
          code: "unknown-code",
          principalId: recipient.id,
          now: 50_000,
          database,
        }),
    ].map((redeem) => {
      try {
        redeem();
        return "unexpected success";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(new Set(messages)).toEqual(new Set(["invite is invalid or unavailable"]));
  });

  it("fails generically and atomically when a shared resource retires before redemption", () => {
    const database = createDatabase();
    seed(database);
    const created = createTeamsInvite({
      domainId: "domain-1",
      createdByPrincipalId: owner.id,
      ttlMs: 60_000,
      grants: [{ resource: tab, permission: "workspaces.tab.read" }],
      database,
    });
    retireAuthorizationResource({
      domainId: "domain-1",
      resource: tab,
      retiredByPrincipalId: owner.id,
      database,
    });

    expect(() =>
      redeemTeamsInvite({ code: created.code, principalId: recipient.id, database }),
    ).toThrow("invite is invalid or unavailable");
    const { db } = openOpenClawStateDatabase(database);
    expect(
      db
        .prepare(
          "SELECT 1 AS found FROM authorization_domain_memberships WHERE domain_id = ? AND principal_id = ?",
        )
        .get("domain-1", recipient.id),
    ).toBeUndefined();
  });

  it("guards invite payload and terminal states against direct SQL mutation", () => {
    const database = createDatabase();
    seed(database);
    const created = createTeamsInvite({
      id: "invite-1",
      domainId: "domain-1",
      createdByPrincipalId: owner.id,
      ttlMs: 60_000,
      grants: [{ resource: tab, permission: "workspaces.tab.read" }],
      database,
    });
    revokeTeamsInvite({
      id: created.invite.id,
      domainId: "domain-1",
      revokedByPrincipalId: owner.id,
      database,
    });
    const { db } = openOpenClawStateDatabase(database);
    expect(() =>
      db
        .prepare("UPDATE teams_invites SET state = 'active', revoked_at = NULL WHERE invite_id = ?")
        .run(created.invite.id),
    ).toThrow(/terminal/i);
    expect(() =>
      db
        .prepare("UPDATE teams_invites SET code_digest = ? WHERE invite_id = ?")
        .run("x", created.invite.id),
    ).toThrow(/immutable/i);
    expect(() =>
      db.prepare("DELETE FROM teams_invites WHERE invite_id = ?").run(created.invite.id),
    ).toThrow(/cannot be deleted/i);
  });
});
