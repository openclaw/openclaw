import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { GatewayPrincipal } from "../../../packages/gateway-protocol/src/schema/frames.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import {
  normalizeTeamsLoginLabel,
  prepareTeamsPassword,
  verifyTeamsPassword,
} from "./teams-password.js";

type TeamsIdentityDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "authorization_domain_memberships"
  | "authorization_principals"
  | "teams_local_accounts"
  | "teams_sessions"
>;

type DatabaseInput = { database?: OpenClawStateDatabaseOptions };

const MIN_SESSION_TTL_MS = 60_000;
const MAX_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export type TeamsLocalAccount = Readonly<{
  id: string;
  principalId: string;
  loginLabel: string;
  createdAt: number;
}>;

export type TeamsSession = Readonly<{
  id: string;
  accountId: string;
  principalId: string;
  principal: GatewayPrincipal;
  domainId: string;
  state: "active" | "revoked";
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  revokedByPrincipalId: string | null;
}>;

export type CreatedTeamsSession = Readonly<{
  token: string;
  session: TeamsSession;
}>;

function getTeamsIdentityKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<TeamsIdentityDatabase>(db);
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}

function validateTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_SESSION_TTL_MS || ttlMs > MAX_SESSION_TTL_MS) {
    throw new Error("Teams session TTL is outside the supported range");
  }
}

function digestOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function mapAccount(row: {
  account_id: string;
  principal_id: string;
  login_label: string;
  created_at: number;
}): TeamsLocalAccount {
  return Object.freeze({
    id: row.account_id,
    principalId: row.principal_id,
    loginLabel: row.login_label,
    createdAt: row.created_at,
  });
}

function mapSession(row: {
  session_id: string;
  account_id: string;
  principal_id: string;
  issuer: string;
  subject: string;
  kind: string;
  domain_id: string;
  state: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  revoked_by_principal_id: string | null;
}): TeamsSession {
  if ((row.state !== "active" && row.state !== "revoked") || row.kind !== "human") {
    throw new Error("Teams session has an invalid persisted state");
  }
  return Object.freeze({
    id: row.session_id,
    accountId: row.account_id,
    principalId: row.principal_id,
    principal: Object.freeze({ issuer: row.issuer, subject: row.subject, kind: row.kind }),
    domainId: row.domain_id,
    state: row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedByPrincipalId: row.revoked_by_principal_id,
  });
}

export async function createTeamsLocalAccount(
  input: DatabaseInput & {
    id: string;
    principalId: string;
    loginLabel: string;
    password: string;
  },
): Promise<TeamsLocalAccount> {
  const id = requiredIdentifier(input.id, "Teams account id");
  const principalId = requiredIdentifier(input.principalId, "Teams account principal id");
  const loginLabel = normalizeTeamsLoginLabel(input.loginLabel);
  const password = await prepareTeamsPassword(input.password);

  return runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getTeamsIdentityKysely(db);
    const principal = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_principals")
        .select("kind")
        .where("principal_id", "=", principalId),
    );
    if (principal?.kind !== "human") {
      throw new Error("Teams local account must map to a human principal");
    }
    const existing = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("teams_local_accounts")
        .select(["account_id", "principal_id", "login_label"])
        .where((where) =>
          where.or([
            where("account_id", "=", id),
            where("principal_id", "=", principalId),
            where("login_label", "=", loginLabel),
          ]),
        ),
    );
    if (existing) {
      if (existing.login_label === loginLabel) {
        throw new Error("Teams login label is already in use");
      }
      throw new Error("Teams account id or principal is already mapped");
    }

    const createdAt = Date.now();
    executeSqliteQuerySync(
      db,
      kysely.insertInto("teams_local_accounts").values({
        account_id: id,
        principal_id: principalId,
        login_label: loginLabel,
        password_salt: password.salt,
        password_verifier: password.verifier,
        password_scrypt_n: password.n,
        password_scrypt_r: password.r,
        password_scrypt_p: password.p,
        created_at: createdAt,
      }),
    );
    return Object.freeze({ id, principalId, loginLabel, createdAt });
  }, input.database);
}

export async function authenticateTeamsLocalAccount(
  input: DatabaseInput & { loginLabel: string; password: string },
): Promise<TeamsLocalAccount | undefined> {
  let loginLabel: string;
  try {
    loginLabel = normalizeTeamsLoginLabel(input.loginLabel);
  } catch {
    return undefined;
  }

  const { db } = openOpenClawStateDatabase(input.database);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getTeamsIdentityKysely(db)
      .selectFrom("teams_local_accounts")
      .selectAll()
      .where("login_label", "=", loginLabel),
  );
  const verified = await verifyTeamsPassword(
    input.password,
    row
      ? {
          salt: row.password_salt,
          verifier: row.password_verifier,
          n: row.password_scrypt_n,
          r: row.password_scrypt_r,
          p: row.password_scrypt_p,
        }
      : undefined,
  );
  if (!row || !verified) {
    return undefined;
  }
  return mapAccount(row);
}

export function createTeamsSession(
  input: DatabaseInput & {
    accountId: string;
    domainId: string;
    ttlMs: number;
    now?: number;
  },
): CreatedTeamsSession {
  const accountId = requiredIdentifier(input.accountId, "Teams account id");
  const domainId = requiredIdentifier(input.domainId, "Teams session domain id");
  validateTtl(input.ttlMs);
  const now = input.now ?? Date.now();
  const token = randomBytes(32).toString("base64url");
  const sessionId = randomUUID();
  const tokenDigest = digestOpaqueToken(token);

  const session = runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getTeamsIdentityKysely(db);
    const account = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("teams_local_accounts as account")
        .innerJoin(
          "authorization_principals as principal",
          "principal.principal_id",
          "account.principal_id",
        )
        .innerJoin("authorization_domain_memberships as membership", (join) =>
          join
            .onRef("membership.principal_id", "=", "account.principal_id")
            .on("membership.domain_id", "=", domainId),
        )
        .select(["account.principal_id", "principal.issuer", "principal.subject", "principal.kind"])
        .where("account.account_id", "=", accountId),
    );
    if (account?.kind !== "human") {
      throw new Error("Teams session account principal must be a human domain member");
    }
    const row = {
      session_id: sessionId,
      token_digest: tokenDigest,
      account_id: accountId,
      principal_id: account.principal_id,
      domain_id: domainId,
      state: "active",
      created_at: now,
      expires_at: now + input.ttlMs,
      revoked_at: null,
      revoked_by_principal_id: null,
    } as const;
    executeSqliteQuerySync(db, kysely.insertInto("teams_sessions").values(row));
    return mapSession({
      ...row,
      issuer: account.issuer,
      subject: account.subject,
      kind: account.kind,
    });
  }, input.database);

  return Object.freeze({ token, session });
}

export function resolveTeamsSession(
  input: DatabaseInput & { token: string; now?: number },
): TeamsSession | undefined {
  const tokenDigest = digestOpaqueToken(input.token);
  const now = input.now ?? Date.now();
  const { db } = openOpenClawStateDatabase(input.database);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getTeamsIdentityKysely(db)
      .selectFrom("teams_sessions as session")
      .innerJoin("teams_local_accounts as account", (join) =>
        join
          .onRef("account.account_id", "=", "session.account_id")
          .onRef("account.principal_id", "=", "session.principal_id"),
      )
      .innerJoin("authorization_domain_memberships as membership", (join) =>
        join
          .onRef("membership.domain_id", "=", "session.domain_id")
          .onRef("membership.principal_id", "=", "session.principal_id"),
      )
      .innerJoin(
        "authorization_principals as principal",
        "principal.principal_id",
        "session.principal_id",
      )
      .select([
        "session.session_id",
        "session.account_id",
        "session.principal_id",
        "principal.issuer",
        "principal.subject",
        "principal.kind",
        "session.domain_id",
        "session.state",
        "session.created_at",
        "session.expires_at",
        "session.revoked_at",
        "session.revoked_by_principal_id",
      ])
      .where("session.token_digest", "=", tokenDigest)
      .where("session.state", "=", "active")
      .where("session.expires_at", ">", now),
  );
  return row ? mapSession(row) : undefined;
}

/** Resolves one active session by its server-private id for established WS revalidation. */
export function resolveTeamsSessionById(
  input: DatabaseInput & { id: string; now?: number },
): TeamsSession | undefined {
  const id = requiredIdentifier(input.id, "Teams session id");
  const now = input.now ?? Date.now();
  const { db } = openOpenClawStateDatabase(input.database);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getTeamsIdentityKysely(db)
      .selectFrom("teams_sessions as session")
      .innerJoin("teams_local_accounts as account", (join) =>
        join
          .onRef("account.account_id", "=", "session.account_id")
          .onRef("account.principal_id", "=", "session.principal_id"),
      )
      .innerJoin("authorization_domain_memberships as membership", (join) =>
        join
          .onRef("membership.domain_id", "=", "session.domain_id")
          .onRef("membership.principal_id", "=", "session.principal_id"),
      )
      .innerJoin(
        "authorization_principals as principal",
        "principal.principal_id",
        "session.principal_id",
      )
      .select([
        "session.session_id",
        "session.account_id",
        "session.principal_id",
        "principal.issuer",
        "principal.subject",
        "principal.kind",
        "session.domain_id",
        "session.state",
        "session.created_at",
        "session.expires_at",
        "session.revoked_at",
        "session.revoked_by_principal_id",
      ])
      .where("session.session_id", "=", id)
      .where("session.state", "=", "active")
      .where("session.expires_at", ">", now),
  );
  return row ? mapSession(row) : undefined;
}

export function listTeamsSessions(
  input: DatabaseInput & { accountId: string },
): readonly TeamsSession[] {
  const accountId = requiredIdentifier(input.accountId, "Teams account id");
  const { db } = openOpenClawStateDatabase(input.database);
  return executeSqliteQuerySync(
    db,
    getTeamsIdentityKysely(db)
      .selectFrom("teams_sessions as session")
      .innerJoin(
        "authorization_principals as principal",
        "principal.principal_id",
        "session.principal_id",
      )
      .select([
        "session.session_id",
        "session.account_id",
        "session.principal_id",
        "principal.issuer",
        "principal.subject",
        "principal.kind",
        "session.domain_id",
        "session.state",
        "session.created_at",
        "session.expires_at",
        "session.revoked_at",
        "session.revoked_by_principal_id",
      ])
      .where("session.account_id", "=", accountId)
      .orderBy("session.created_at", "desc")
      .orderBy("session.session_id", "asc"),
  ).rows.map(mapSession);
}

export function revokeTeamsSession(
  input: DatabaseInput & {
    id: string;
    revokedByPrincipalId: string;
    now?: number;
  },
): void {
  const id = requiredIdentifier(input.id, "Teams session id");
  const revokedByPrincipalId = requiredIdentifier(
    input.revokedByPrincipalId,
    "Teams session revoking principal id",
  );
  runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getTeamsIdentityKysely(db);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("teams_sessions")
        .select(["state", "created_at"])
        .where("session_id", "=", id),
    );
    if (!row) {
      throw new Error("unknown Teams session");
    }
    if (row.state === "revoked") {
      return;
    }
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("teams_sessions")
        .set({
          state: "revoked",
          revoked_at: input.now ?? Date.now(),
          revoked_by_principal_id: revokedByPrincipalId,
        })
        .where("session_id", "=", id)
        .where("state", "=", "active"),
    );
  }, input.database);
}
