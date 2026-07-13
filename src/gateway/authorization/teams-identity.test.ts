import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  addIsolationDomainMember,
  createIsolationDomain,
  putAuthorizationPrincipal,
  removeIsolationDomainMember,
} from "./state-store.js";
import {
  authenticateTeamsLocalAccount,
  createTeamsLocalAccount,
  createTeamsSession,
  listTeamsSessions,
  resolveTeamsSession,
  resolveTeamsSessionById,
  revokeTeamsSession,
} from "./teams-identity.js";

const tempDirs: string[] = [];
const owner = {
  id: "principal-owner",
  principal: { issuer: "local", subject: "owner", kind: "human" },
} as const;

function createDatabase() {
  return { path: `${makeTempDir(tempDirs, "openclaw-teams-identity-")}/openclaw.sqlite` };
}

function seedOwner(database: ReturnType<typeof createDatabase>) {
  putAuthorizationPrincipal({ ...owner, database });
  createIsolationDomain({ id: "domain-1", ownerPrincipalId: owner.id, database });
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("Teams local accounts", () => {
  it("maps one normalized login label to one human principal without exposing password material", async () => {
    const database = createDatabase();
    seedOwner(database);

    const account = await createTeamsLocalAccount({
      id: "account-1",
      principalId: owner.id,
      loginLabel: "  OWNER@Example.COM  ",
      password: "correct horse battery staple",
      database,
    });

    expect(account).toEqual({
      id: "account-1",
      principalId: owner.id,
      loginLabel: "owner@example.com",
      createdAt: expect.any(Number),
    });
    expect(Object.keys(account)).not.toContain("passwordHash");
    expect(Object.keys(account)).not.toContain("passwordSalt");

    await expect(
      authenticateTeamsLocalAccount({
        loginLabel: "Owner@example.com",
        password: "correct horse battery staple",
        database,
      }),
    ).resolves.toEqual(account);
    await expect(
      authenticateTeamsLocalAccount({
        loginLabel: "owner@example.com",
        password: "wrong password",
        database,
      }),
    ).resolves.toBeUndefined();

    const { db } = openOpenClawStateDatabase(database);
    const stored = db
      .prepare(
        `SELECT login_label, password_salt, password_verifier
           FROM teams_local_accounts
          WHERE account_id = ?`,
      )
      .get(account.id) as {
      login_label: string;
      password_salt: Uint8Array;
      password_verifier: Uint8Array;
    };
    expect(stored.login_label).toBe("owner@example.com");
    expect(Buffer.from(stored.password_salt).toString("utf8")).not.toContain(account.loginLabel);
    expect(Buffer.from(stored.password_verifier).toString("utf8")).not.toContain(
      "correct horse battery staple",
    );
  });

  it("rejects duplicate normalized labels, non-human mappings, and oversized passwords", async () => {
    const database = createDatabase();
    seedOwner(database);
    await createTeamsLocalAccount({
      id: "account-1",
      principalId: owner.id,
      loginLabel: "owner@example.com",
      password: "correct horse battery staple",
      database,
    });

    await expect(
      createTeamsLocalAccount({
        id: "account-2",
        principalId: owner.id,
        loginLabel: " OWNER@example.com ",
        password: "another safe password",
        database,
      }),
    ).rejects.toThrow(/login label is already in use/i);

    const service = {
      id: "principal-service",
      principal: { issuer: "core", subject: "agent:main", kind: "service" },
    } as const;
    putAuthorizationPrincipal({ ...service, database });
    await expect(
      createTeamsLocalAccount({
        id: "account-service",
        principalId: service.id,
        loginLabel: "agent@example.com",
        password: "another safe password",
        database,
      }),
    ).rejects.toThrow(/human principal/i);

    await expect(
      createTeamsLocalAccount({
        id: "account-large",
        principalId: owner.id,
        loginLabel: "large@example.com",
        password: "x".repeat(1_025),
        database,
      }),
    ).rejects.toThrow(/password/i);
  });
});

describe("Teams sessions", () => {
  it("stores only a token digest and resolves one exact unexpired domain session", async () => {
    const database = createDatabase();
    seedOwner(database);
    await createTeamsLocalAccount({
      id: "account-1",
      principalId: owner.id,
      loginLabel: "owner@example.com",
      password: "correct horse battery staple",
      database,
    });

    const created = createTeamsSession({
      accountId: "account-1",
      domainId: "domain-1",
      ttlMs: 60_000,
      database,
    });
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(created.session).toMatchObject({
      id: expect.any(String),
      accountId: "account-1",
      principalId: owner.id,
      principal: owner.principal,
      domainId: "domain-1",
      state: "active",
    });
    expect(Object.keys(created.session)).not.toContain("tokenDigest");
    expect(resolveTeamsSession({ token: created.token, database })).toEqual(created.session);
    expect(resolveTeamsSessionById({ id: created.session.id, database })).toEqual(created.session);
    expect(resolveTeamsSession({ token: `${created.token}x`, database })).toBeUndefined();

    const listed = listTeamsSessions({ accountId: "account-1", database });
    expect(listed).toEqual([created.session]);
    expect(JSON.stringify(listed)).not.toContain(created.token);

    const { db } = openOpenClawStateDatabase(database);
    const stored = db
      .prepare("SELECT token_digest FROM teams_sessions WHERE session_id = ?")
      .get(created.session.id) as { token_digest: string };
    expect(stored.token_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.token_digest).not.toBe(created.token);
  });

  it("rejects non-members, expires sessions, and makes revocation monotonic", async () => {
    const database = createDatabase();
    seedOwner(database);
    await createTeamsLocalAccount({
      id: "account-1",
      principalId: owner.id,
      loginLabel: "owner@example.com",
      password: "correct horse battery staple",
      database,
    });
    expect(() =>
      createTeamsSession({
        accountId: "account-1",
        domainId: "missing-domain",
        ttlMs: 60_000,
        database,
      }),
    ).toThrow(/domain member/i);

    const created = createTeamsSession({
      accountId: "account-1",
      domainId: "domain-1",
      ttlMs: 60_000,
      now: 10_000,
      database,
    });
    expect(resolveTeamsSession({ token: created.token, now: 69_999, database })).toBeDefined();
    expect(resolveTeamsSession({ token: created.token, now: 70_000, database })).toBeUndefined();
    expect(
      resolveTeamsSessionById({ id: created.session.id, now: 70_000, database }),
    ).toBeUndefined();

    const active = createTeamsSession({
      accountId: "account-1",
      domainId: "domain-1",
      ttlMs: 60_000,
      now: 20_000,
      database,
    });
    revokeTeamsSession({
      id: active.session.id,
      revokedByPrincipalId: owner.id,
      now: 30_000,
      database,
    });
    expect(resolveTeamsSession({ token: active.token, now: 30_001, database })).toBeUndefined();
    expect(
      resolveTeamsSessionById({ id: active.session.id, now: 30_001, database }),
    ).toBeUndefined();

    const { db } = openOpenClawStateDatabase(database);
    expect(() =>
      db
        .prepare(
          "UPDATE teams_sessions SET state = 'active', revoked_at = NULL, revoked_by_principal_id = NULL WHERE session_id = ?",
        )
        .run(active.session.id),
    ).toThrow(/cannot be reactivated/i);
    expect(() =>
      db.prepare("DELETE FROM teams_sessions WHERE session_id = ?").run(active.session.id),
    ).toThrow(/cannot be deleted/i);
  });

  it("stops resolving a session when its principal leaves the exact domain", async () => {
    const database = createDatabase();
    seedOwner(database);
    const member = {
      id: "principal-member",
      principal: { issuer: "local", subject: "member", kind: "human" },
    } as const;
    putAuthorizationPrincipal({ ...member, database });
    addIsolationDomainMember({
      domainId: "domain-1",
      principalId: member.id,
      addedByPrincipalId: owner.id,
      database,
    });
    await createTeamsLocalAccount({
      id: "account-member",
      principalId: member.id,
      loginLabel: "member@example.com",
      password: "correct horse battery staple",
      database,
    });
    const created = createTeamsSession({
      accountId: "account-member",
      domainId: "domain-1",
      ttlMs: 60_000,
      database,
    });

    removeIsolationDomainMember({
      domainId: "domain-1",
      principalId: member.id,
      removedByPrincipalId: owner.id,
      database,
    });
    expect(resolveTeamsSession({ token: created.token, database })).toBeUndefined();
    expect(resolveTeamsSessionById({ id: created.session.id, database })).toBeUndefined();
  });
});
