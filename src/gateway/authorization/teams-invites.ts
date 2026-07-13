import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
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
import type { GatewayResourceRef } from "./contracts.js";
import {
  createTeamsSession,
  type CreatedTeamsSession,
  type TeamsLocalAccount,
} from "./teams-identity.js";
import { normalizeTeamsLoginLabel, prepareTeamsPassword } from "./teams-password.js";

type TeamsInviteDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "authorization_domain_memberships"
  | "authorization_grants"
  | "authorization_principals"
  | "authorization_resources"
  | "teams_invite_grants"
  | "teams_invites"
  | "teams_local_accounts"
>;

type DatabaseInput = { database?: OpenClawStateDatabaseOptions };
const MIN_INVITE_TTL_MS = 60_000;
const MAX_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const INVITE_UNAVAILABLE_MESSAGE = "invite is invalid or unavailable";

export type TeamsInviteGrant = Readonly<{
  resource: GatewayResourceRef;
  permission: string;
}>;

export type TeamsInvite = Readonly<{
  id: string;
  domainId: string;
  createdByPrincipalId: string;
  recipientLabel: string | null;
  state: "active" | "redeemed" | "revoked";
  createdAt: number;
  expiresAt: number;
  redeemedAt: number | null;
  redeemedByPrincipalId: string | null;
  revokedAt: number | null;
  grants: readonly TeamsInviteGrant[];
}>;

export type CreatedTeamsInvite = Readonly<{
  code: string;
  invite: TeamsInvite;
}>;

export type RegisteredTeamsLocalAccountFromInvite = Readonly<{
  account: TeamsLocalAccount;
  invite: TeamsInvite;
  session: CreatedTeamsSession;
  validation?: unknown;
}>;

type RedeemableInvite = Readonly<{
  invite_id: string;
  domain_id: string;
  created_by_principal_id: string;
}>;

function getTeamsInviteKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<TeamsInviteDatabase>(db);
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}

function normalizeRecipientLabel(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (!normalized || normalized.length > 254) {
    throw new Error("invite recipient label must contain between 1 and 254 characters");
  }
  // V1 deliberately treats this as display-only; possession of the opaque code is the proof.
  return normalized;
}

function normalizeResource(resource: GatewayResourceRef): GatewayResourceRef {
  return Object.freeze({
    namespace: requiredIdentifier(resource.namespace, "invite resource namespace"),
    type: requiredIdentifier(resource.type, "invite resource type"),
    id: requiredIdentifier(resource.id, "invite resource id"),
  });
}

function normalizeGrants(grants: readonly TeamsInviteGrant[]): readonly TeamsInviteGrant[] {
  if (grants.length === 0 || grants.length > 100) {
    throw new Error("Teams invite must contain between 1 and 100 grants");
  }
  const seen = new Set<string>();
  return grants.map((grant) => {
    const resource = normalizeResource(grant.resource);
    const permission = requiredIdentifier(grant.permission, "invite permission");
    const key = `${resource.namespace}\u0000${resource.type}\u0000${resource.id}\u0000${permission}`;
    if (seen.has(key)) {
      throw new Error("Teams invite contains a duplicate resource permission grant");
    }
    seen.add(key);
    return Object.freeze({ resource, permission });
  });
}

function validateTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_INVITE_TTL_MS || ttlMs > MAX_INVITE_TTL_MS) {
    throw new Error("Teams invite TTL is outside the supported range");
  }
}

function digestInviteCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

function requireDomainOwner(db: DatabaseSync, domainId: string, principalId: string): void {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getTeamsInviteKysely(db)
      .selectFrom("authorization_domain_memberships as membership")
      .innerJoin(
        "authorization_principals as principal",
        "principal.principal_id",
        "membership.principal_id",
      )
      .select(["membership.role", "principal.kind"])
      .where("membership.domain_id", "=", domainId)
      .where("membership.principal_id", "=", principalId),
  );
  if (row?.role !== "owner" || row.kind !== "human") {
    throw new Error("Teams invite creator must be the current human domain owner");
  }
}

function mapInviteGrant(row: {
  namespace: string;
  resource_type: string;
  resource_id: string;
  permission: string;
}): TeamsInviteGrant {
  return Object.freeze({
    resource: Object.freeze({
      namespace: row.namespace,
      type: row.resource_type,
      id: row.resource_id,
    }),
    permission: row.permission,
  });
}

function mapInvite(
  row: {
    invite_id: string;
    domain_id: string;
    created_by_principal_id: string;
    recipient_label: string | null;
    state: string;
    created_at: number;
    expires_at: number;
    redeemed_at: number | null;
    redeemed_by_principal_id: string | null;
    revoked_at: number | null;
  },
  grants: readonly TeamsInviteGrant[],
): TeamsInvite {
  if (row.state !== "active" && row.state !== "redeemed" && row.state !== "revoked") {
    throw new Error("Teams invite has an invalid persisted state");
  }
  return Object.freeze({
    id: row.invite_id,
    domainId: row.domain_id,
    createdByPrincipalId: row.created_by_principal_id,
    recipientLabel: row.recipient_label,
    state: row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    redeemedAt: row.redeemed_at,
    redeemedByPrincipalId: row.redeemed_by_principal_id,
    revokedAt: row.revoked_at,
    grants: Object.freeze([...grants]),
  });
}

function loadInvite(db: DatabaseSync, inviteId: string): TeamsInvite | undefined {
  const kysely = getTeamsInviteKysely(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("teams_invites")
      .select([
        "invite_id",
        "domain_id",
        "created_by_principal_id",
        "recipient_label",
        "state",
        "created_at",
        "expires_at",
        "redeemed_at",
        "redeemed_by_principal_id",
        "revoked_at",
      ])
      .where("invite_id", "=", inviteId),
  );
  if (!row) {
    return undefined;
  }
  const grants = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("teams_invite_grants")
      .select(["namespace", "resource_type", "resource_id", "permission"])
      .where("invite_id", "=", inviteId)
      .orderBy("created_at", "asc")
      .orderBy("namespace", "asc")
      .orderBy("resource_type", "asc")
      .orderBy("resource_id", "asc")
      .orderBy("permission", "asc"),
  ).rows.map(mapInviteGrant);
  return mapInvite(row, grants);
}

function loadRedeemableInvite(db: DatabaseSync, codeDigest: string, now: number): RedeemableInvite {
  const invite = executeSqliteQueryTakeFirstSync(
    db,
    getTeamsInviteKysely(db)
      .selectFrom("teams_invites")
      .select(["invite_id", "domain_id", "created_by_principal_id"])
      .where("code_digest", "=", codeDigest)
      .where("state", "=", "active")
      .where("expires_at", ">", now),
  );
  if (!invite) {
    throw new Error(INVITE_UNAVAILABLE_MESSAGE);
  }
  return invite;
}

function redeemInviteForHumanPrincipal(input: {
  db: DatabaseSync;
  invite: RedeemableInvite;
  principalId: string;
  now: number;
}): TeamsInvite {
  const kysely = getTeamsInviteKysely(input.db);
  const principal = executeSqliteQueryTakeFirstSync(
    input.db,
    kysely
      .selectFrom("authorization_principals")
      .select("kind")
      .where("principal_id", "=", input.principalId),
  );
  if (principal?.kind !== "human") {
    throw new Error(INVITE_UNAVAILABLE_MESSAGE);
  }
  const grants = executeSqliteQuerySync(
    input.db,
    kysely
      .selectFrom("teams_invite_grants as manifest")
      .innerJoin("authorization_resources as resource", (join) =>
        join
          .onRef("resource.domain_id", "=", "manifest.domain_id")
          .onRef("resource.namespace", "=", "manifest.namespace")
          .onRef("resource.resource_type", "=", "manifest.resource_type")
          .onRef("resource.resource_id", "=", "manifest.resource_id"),
      )
      .select([
        "manifest.namespace",
        "manifest.resource_type",
        "manifest.resource_id",
        "manifest.permission",
      ])
      .where("manifest.invite_id", "=", input.invite.invite_id)
      .where("resource.retired_at", "is", null),
  ).rows;
  const manifestCount = executeSqliteQueryTakeFirstSync(
    input.db,
    kysely
      .selectFrom("teams_invite_grants")
      .select((select) => select.fn.countAll<number>().as("count"))
      .where("invite_id", "=", input.invite.invite_id),
  )?.count;
  if (grants.length === 0 || grants.length !== manifestCount) {
    throw new Error(INVITE_UNAVAILABLE_MESSAGE);
  }

  executeSqliteQuerySync(
    input.db,
    kysely
      .insertInto("authorization_domain_memberships")
      .values({
        domain_id: input.invite.domain_id,
        principal_id: input.principalId,
        role: "member",
        added_by_principal_id: input.invite.created_by_principal_id,
        added_by_role: "owner",
        created_at: input.now,
      })
      .onConflict((conflict) => conflict.columns(["domain_id", "principal_id"]).doNothing()),
  );
  for (const grant of grants) {
    executeSqliteQuerySync(
      input.db,
      kysely
        .insertInto("authorization_grants")
        .values({
          domain_id: input.invite.domain_id,
          principal_id: input.principalId,
          namespace: grant.namespace,
          resource_type: grant.resource_type,
          resource_id: grant.resource_id,
          permission: grant.permission,
          granted_by_principal_id: input.invite.created_by_principal_id,
          created_at: input.now,
        })
        .onConflict((conflict) =>
          conflict
            .columns([
              "domain_id",
              "principal_id",
              "namespace",
              "resource_type",
              "resource_id",
              "permission",
            ])
            .doNothing(),
        ),
    );
  }
  const claimed = executeSqliteQuerySync(
    input.db,
    kysely
      .updateTable("teams_invites")
      .set({
        state: "redeemed",
        redeemed_at: input.now,
        redeemed_by_principal_id: input.principalId,
      })
      .where("invite_id", "=", input.invite.invite_id)
      .where("state", "=", "active")
      .where("expires_at", ">", input.now),
  );
  if (claimed.numAffectedRows !== 1n) {
    throw new Error(INVITE_UNAVAILABLE_MESSAGE);
  }
  const loaded = loadInvite(input.db, input.invite.invite_id);
  if (!loaded) {
    throw new Error(INVITE_UNAVAILABLE_MESSAGE);
  }
  return loaded;
}

export function createTeamsInvite(
  input: DatabaseInput & {
    id?: string;
    domainId: string;
    createdByPrincipalId: string;
    recipientLabel?: string;
    ttlMs: number;
    grants: readonly TeamsInviteGrant[];
    now?: number;
  },
): CreatedTeamsInvite {
  const id = requiredIdentifier(input.id ?? randomUUID(), "Teams invite id");
  const domainId = requiredIdentifier(input.domainId, "Teams invite domain id");
  const createdByPrincipalId = requiredIdentifier(
    input.createdByPrincipalId,
    "Teams invite creator principal id",
  );
  const recipientLabel = normalizeRecipientLabel(input.recipientLabel);
  const grants = normalizeGrants(input.grants);
  validateTtl(input.ttlMs);
  const code = randomBytes(32).toString("base64url");
  const codeDigest = digestInviteCode(code);
  const createdAt = input.now ?? Date.now();

  const invite = runOpenClawStateWriteTransaction(({ db }) => {
    requireDomainOwner(db, domainId, createdByPrincipalId);
    const kysely = getTeamsInviteKysely(db);
    for (const grant of grants) {
      const resource = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("authorization_resources")
          .select("retired_at")
          .where("domain_id", "=", domainId)
          .where("namespace", "=", grant.resource.namespace)
          .where("resource_type", "=", grant.resource.type)
          .where("resource_id", "=", grant.resource.id),
      );
      if (!resource || resource.retired_at !== null) {
        throw new Error("Teams invite grant must reference an active resource in the domain");
      }
    }

    executeSqliteQuerySync(
      db,
      kysely.insertInto("teams_invites").values({
        invite_id: id,
        code_digest: codeDigest,
        domain_id: domainId,
        created_by_principal_id: createdByPrincipalId,
        recipient_label: recipientLabel,
        state: "active",
        created_at: createdAt,
        expires_at: createdAt + input.ttlMs,
        redeemed_at: null,
        redeemed_by_principal_id: null,
        revoked_at: null,
        revoked_by_principal_id: null,
      }),
    );
    for (const grant of grants) {
      executeSqliteQuerySync(
        db,
        kysely.insertInto("teams_invite_grants").values({
          invite_id: id,
          domain_id: domainId,
          namespace: grant.resource.namespace,
          resource_type: grant.resource.type,
          resource_id: grant.resource.id,
          permission: grant.permission,
          created_at: createdAt,
        }),
      );
    }
    const loaded = loadInvite(db, id);
    if (!loaded) {
      throw new Error("failed to load the created Teams invite");
    }
    return loaded;
  }, input.database);

  return Object.freeze({ code, invite });
}

export function listTeamsInvites(
  input: DatabaseInput & { domainId: string; requestedByPrincipalId: string },
): readonly TeamsInvite[] {
  const domainId = requiredIdentifier(input.domainId, "Teams invite domain id");
  const requestedByPrincipalId = requiredIdentifier(
    input.requestedByPrincipalId,
    "Teams invite requesting principal id",
  );
  const { db } = openOpenClawStateDatabase(input.database);
  requireDomainOwner(db, domainId, requestedByPrincipalId);
  const ids = executeSqliteQuerySync(
    db,
    getTeamsInviteKysely(db)
      .selectFrom("teams_invites")
      .select("invite_id")
      .where("domain_id", "=", domainId)
      .orderBy("created_at", "desc")
      .orderBy("invite_id", "asc"),
  ).rows;
  return ids.map(({ invite_id }) => {
    const invite = loadInvite(db, invite_id);
    if (!invite) {
      throw new Error("Teams invite disappeared while listing");
    }
    return invite;
  });
}

export function redeemTeamsInvite(
  input: DatabaseInput & {
    code: string;
    principalId: string;
    now?: number;
  },
): TeamsInvite {
  const codeDigest = digestInviteCode(input.code);
  const principalId = requiredIdentifier(input.principalId, "Teams invite recipient principal id");
  const now = input.now ?? Date.now();

  return runOpenClawStateWriteTransaction(({ db }) => {
    const invite = loadRedeemableInvite(db, codeDigest, now);
    return redeemInviteForHumanPrincipal({ db, invite, principalId, now });
  }, input.database);
}

export async function registerTeamsLocalAccountFromInvite(
  input: DatabaseInput & {
    code: string;
    accountId?: string;
    principalId?: string;
    loginLabel: string;
    password: string;
    sessionTtlMs: number;
    validateInvite?: (invite: TeamsInvite) => unknown;
    now?: number;
  },
): Promise<RegisteredTeamsLocalAccountFromInvite> {
  const codeDigest = digestInviteCode(input.code);
  const accountId = requiredIdentifier(input.accountId ?? randomUUID(), "Teams account id");
  const principalId = requiredIdentifier(input.principalId ?? randomUUID(), "Teams principal id");
  const loginLabel = normalizeTeamsLoginLabel(input.loginLabel);
  // Scrypt stays off the synchronous SQLite critical section; no identity rows exist yet.
  const password = await prepareTeamsPassword(input.password);
  const now = input.now ?? Date.now();
  const principal = Object.freeze({
    issuer: "openclaw-local",
    subject: loginLabel,
    kind: "human" as const,
  });

  return runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getTeamsInviteKysely(db);
    const invite = loadRedeemableInvite(db, codeDigest, now);
    const loadedInvite = loadInvite(db, invite.invite_id);
    if (!loadedInvite) {
      throw new Error(INVITE_UNAVAILABLE_MESSAGE);
    }
    const validation = input.validateInvite?.(loadedInvite);
    const existing = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("teams_local_accounts as account")
        .leftJoin("authorization_principals as principal", (join) =>
          join
            .on("principal.principal_id", "=", principalId)
            .on("principal.issuer", "=", principal.issuer)
            .on("principal.subject", "=", principal.subject)
            .on("principal.kind", "=", principal.kind),
        )
        .select(["account.account_id", "account.login_label", "principal.principal_id"])
        .where((where) =>
          where.or([
            where("account.account_id", "=", accountId),
            where("account.principal_id", "=", principalId),
            where("account.login_label", "=", loginLabel),
          ]),
        ),
    );
    if (existing?.login_label === loginLabel) {
      throw new Error("Teams login label is already in use");
    }
    if (existing) {
      throw new Error("Teams account id or principal is already mapped");
    }
    const principalIdentity = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_principals")
        .select("principal_id")
        .where((where) =>
          where.or([
            where("principal_id", "=", principalId),
            where.and([
              where("issuer", "=", principal.issuer),
              where("subject", "=", principal.subject),
              where("kind", "=", principal.kind),
            ]),
          ]),
        ),
    );
    if (principalIdentity) {
      throw new Error("Teams account id or principal is already mapped");
    }

    executeSqliteQuerySync(
      db,
      kysely.insertInto("authorization_principals").values({
        principal_id: principalId,
        issuer: principal.issuer,
        subject: principal.subject,
        kind: principal.kind,
        created_at: now,
        updated_at: now,
      }),
    );
    executeSqliteQuerySync(
      db,
      kysely.insertInto("teams_local_accounts").values({
        account_id: accountId,
        principal_id: principalId,
        login_label: loginLabel,
        password_salt: password.salt,
        password_verifier: password.verifier,
        password_scrypt_n: password.n,
        password_scrypt_r: password.r,
        password_scrypt_p: password.p,
        created_at: now,
      }),
    );
    const redeemedInvite = redeemInviteForHumanPrincipal({ db, invite, principalId, now });
    const session = createTeamsSession({
      accountId,
      domainId: invite.domain_id,
      ttlMs: input.sessionTtlMs,
      now,
      database: input.database,
    });
    const account = Object.freeze({ id: accountId, principalId, loginLabel, createdAt: now });
    return Object.freeze({
      account,
      invite: redeemedInvite,
      session,
      ...(input.validateInvite ? { validation } : {}),
    });
  }, input.database);
}

export function revokeTeamsInvite(
  input: DatabaseInput & {
    id: string;
    domainId: string;
    revokedByPrincipalId: string;
    now?: number;
  },
): void {
  const id = requiredIdentifier(input.id, "Teams invite id");
  const domainId = requiredIdentifier(input.domainId, "Teams invite domain id");
  const revokedByPrincipalId = requiredIdentifier(
    input.revokedByPrincipalId,
    "Teams invite revoking principal id",
  );
  runOpenClawStateWriteTransaction(({ db }) => {
    requireDomainOwner(db, domainId, revokedByPrincipalId);
    const kysely = getTeamsInviteKysely(db);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("teams_invites")
        .select("state")
        .where("invite_id", "=", id)
        .where("domain_id", "=", domainId),
    );
    if (!row) {
      throw new Error("unknown Teams invite");
    }
    if (row.state === "revoked") {
      return;
    }
    if (row.state !== "active") {
      throw new Error("redeemed Teams invite cannot be revoked");
    }
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("teams_invites")
        .set({
          state: "revoked",
          revoked_at: input.now ?? Date.now(),
          revoked_by_principal_id: revokedByPrincipalId,
        })
        .where("invite_id", "=", id)
        .where("domain_id", "=", domainId)
        .where("state", "=", "active"),
    );
  }, input.database);
}
