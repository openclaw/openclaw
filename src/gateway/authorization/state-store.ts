import type { DatabaseSync } from "node:sqlite";
import type { GatewayPrincipal } from "../../../packages/gateway-protocol/src/schema/frames.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import type { GatewayResourceRef } from "./contracts.js";

type AuthorizationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "authorization_domain_memberships"
  | "authorization_domains"
  | "authorization_grants"
  | "authorization_principals"
  | "authorization_resources"
>;

type AuthorizationDatabaseInput = { database?: OpenClawStateDatabaseOptions };

function getAuthorizationKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<AuthorizationDatabase>(db);
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}

function requiredPrincipalField(value: string, label: string): string {
  if (!value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function normalizeResource(resource: GatewayResourceRef): GatewayResourceRef {
  return {
    namespace: requiredIdentifier(resource.namespace, "resource namespace"),
    type: requiredIdentifier(resource.type, "resource type"),
    id: requiredIdentifier(resource.id, "resource id"),
  };
}

function requireDomainOwner(db: DatabaseSync, domainId: string, principalId: string): void {
  const membership = executeSqliteQueryTakeFirstSync(
    db,
    getAuthorizationKysely(db)
      .selectFrom("authorization_domain_memberships")
      .select("role")
      .where("domain_id", "=", domainId)
      .where("principal_id", "=", principalId),
  );
  if (membership?.role !== "owner") {
    throw new Error(`principal ${principalId} is not the owner of isolation domain ${domainId}`);
  }
}

function requireHumanDomainMember(db: DatabaseSync, domainId: string, principalId: string): void {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getAuthorizationKysely(db)
      .selectFrom("authorization_principals as principal")
      .innerJoin("authorization_domain_memberships as membership", (join) =>
        join
          .onRef("membership.principal_id", "=", "principal.principal_id")
          .on("membership.domain_id", "=", domainId),
      )
      .select("principal.kind")
      .where("principal.principal_id", "=", principalId),
  );
  if (row?.kind !== "human") {
    throw new Error("authorization resource owner must be a human principal in the domain");
  }
}

function requireDomainOrResourceOwner(params: {
  db: DatabaseSync;
  domainId: string;
  principalId: string;
  resource: GatewayResourceRef;
}): void {
  const ownership = executeSqliteQueryTakeFirstSync(
    params.db,
    getAuthorizationKysely(params.db)
      .selectFrom("authorization_domain_memberships as membership")
      .leftJoin("authorization_resources as resource", (join) =>
        join
          .onRef("resource.domain_id", "=", "membership.domain_id")
          .on("resource.namespace", "=", params.resource.namespace)
          .on("resource.resource_type", "=", params.resource.type)
          .on("resource.resource_id", "=", params.resource.id),
      )
      .select(["membership.role", "resource.owner_principal_id"])
      .where("membership.domain_id", "=", params.domainId)
      .where("membership.principal_id", "=", params.principalId),
  );
  if (ownership?.role !== "owner" && ownership?.owner_principal_id !== params.principalId) {
    throw new Error(`principal ${params.principalId} is not the owner of the domain or resource`);
  }
}

export function putAuthorizationPrincipal(
  input: AuthorizationDatabaseInput & {
    id: string;
    principal: GatewayPrincipal;
  },
): void {
  const principalId = requiredIdentifier(input.id, "principal id");
  const issuer = requiredPrincipalField(input.principal.issuer, "principal issuer");
  const subject = requiredPrincipalField(input.principal.subject, "principal subject");
  runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getAuthorizationKysely(db);
    const byId = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_principals")
        .select(["principal_id", "issuer", "subject", "kind"])
        .where("principal_id", "=", principalId),
    );
    const byIdentity = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_principals")
        .select(["principal_id", "issuer", "subject", "kind"])
        .where("issuer", "=", issuer)
        .where("subject", "=", subject)
        .where("kind", "=", input.principal.kind),
    );
    const existing = byId ?? byIdentity;
    if (existing) {
      const matches =
        existing.principal_id === principalId &&
        existing.issuer === issuer &&
        existing.subject === subject &&
        existing.kind === input.principal.kind;
      if (!matches || (byId && byIdentity && byId.principal_id !== byIdentity.principal_id)) {
        throw new Error("authorization principal identity is already mapped differently");
      }
      return;
    }
    const now = Date.now();
    executeSqliteQuerySync(
      db,
      kysely.insertInto("authorization_principals").values({
        principal_id: principalId,
        issuer,
        subject,
        kind: input.principal.kind,
        created_at: now,
        updated_at: now,
      }),
    );
  }, input.database);
}

export function createIsolationDomain(
  input: AuthorizationDatabaseInput & {
    id: string;
    ownerPrincipalId: string;
  },
): void {
  const domainId = requiredIdentifier(input.id, "isolation domain id");
  const ownerPrincipalId = requiredIdentifier(input.ownerPrincipalId, "owner principal id");
  runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getAuthorizationKysely(db);
    const owner = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_principals")
        .select("kind")
        .where("principal_id", "=", ownerPrincipalId),
    );
    if (!owner) {
      throw new Error(`unknown owner principal ${ownerPrincipalId}`);
    }
    // V1 never gives devices, services, shared credentials, or agents domain-admin authority.
    if (owner.kind !== "human") {
      throw new Error("isolation domain owner must be a human principal");
    }
    const existing = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_domains")
        .select("domain_id")
        .where("domain_id", "=", domainId),
    );
    if (existing) {
      requireDomainOwner(db, domainId, ownerPrincipalId);
      return;
    }
    const now = Date.now();
    executeSqliteQuerySync(
      db,
      kysely.insertInto("authorization_domains").values({
        domain_id: domainId,
        created_at: now,
        updated_at: now,
      }),
    );
    executeSqliteQuerySync(
      db,
      kysely.insertInto("authorization_domain_memberships").values({
        domain_id: domainId,
        principal_id: ownerPrincipalId,
        role: "owner",
        added_by_principal_id: ownerPrincipalId,
        added_by_role: "owner",
        created_at: now,
      }),
    );
  }, input.database);
}

export function addIsolationDomainMember(
  input: AuthorizationDatabaseInput & {
    domainId: string;
    principalId: string;
    addedByPrincipalId: string;
  },
): void {
  const domainId = requiredIdentifier(input.domainId, "isolation domain id");
  const principalId = requiredIdentifier(input.principalId, "member principal id");
  const addedByPrincipalId = requiredIdentifier(input.addedByPrincipalId, "owner principal id");
  runOpenClawStateWriteTransaction(({ db }) => {
    requireDomainOwner(db, domainId, addedByPrincipalId);
    executeSqliteQuerySync(
      db,
      getAuthorizationKysely(db)
        .insertInto("authorization_domain_memberships")
        .values({
          domain_id: domainId,
          principal_id: principalId,
          role: "member",
          added_by_principal_id: addedByPrincipalId,
          added_by_role: "owner",
          created_at: Date.now(),
        })
        .onConflict((conflict) => conflict.columns(["domain_id", "principal_id"]).doNothing()),
    );
  }, input.database);
}

export function bindAuthorizationResource(
  input: AuthorizationDatabaseInput & {
    domainId: string;
    resource: GatewayResourceRef;
    ownerPrincipalId: string;
  },
): void {
  const domainId = requiredIdentifier(input.domainId, "isolation domain id");
  const resource = normalizeResource(input.resource);
  const ownerPrincipalId = requiredIdentifier(
    input.ownerPrincipalId,
    "resource owner principal id",
  );
  runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getAuthorizationKysely(db);
    const existing = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_resources")
        .select(["domain_id", "owner_principal_id"])
        .where("namespace", "=", resource.namespace)
        .where("resource_type", "=", resource.type)
        .where("resource_id", "=", resource.id),
    );
    if (existing) {
      if (existing.domain_id !== domainId || existing.owner_principal_id !== ownerPrincipalId) {
        throw new Error("authorization resource is already bound differently");
      }
      return;
    }
    requireHumanDomainMember(db, domainId, ownerPrincipalId);
    executeSqliteQuerySync(
      db,
      kysely.insertInto("authorization_resources").values({
        namespace: resource.namespace,
        resource_type: resource.type,
        resource_id: resource.id,
        domain_id: domainId,
        owner_principal_id: ownerPrincipalId,
        created_at: Date.now(),
      }),
    );
  }, input.database);
}

export function grantAuthorizationPermission(
  input: AuthorizationDatabaseInput & {
    domainId: string;
    principalId: string;
    resource: GatewayResourceRef;
    permission: string;
    grantedByPrincipalId: string;
  },
): void {
  const domainId = requiredIdentifier(input.domainId, "isolation domain id");
  const principalId = requiredIdentifier(input.principalId, "grantee principal id");
  const resource = normalizeResource(input.resource);
  const permission = requiredIdentifier(input.permission, "authorization permission");
  const grantedByPrincipalId = requiredIdentifier(
    input.grantedByPrincipalId,
    "grantor principal id",
  );
  runOpenClawStateWriteTransaction(({ db }) => {
    requireDomainOrResourceOwner({
      db,
      domainId,
      principalId: grantedByPrincipalId,
      resource,
    });
    executeSqliteQuerySync(
      db,
      getAuthorizationKysely(db)
        .insertInto("authorization_grants")
        .values({
          domain_id: domainId,
          principal_id: principalId,
          namespace: resource.namespace,
          resource_type: resource.type,
          resource_id: resource.id,
          permission,
          granted_by_principal_id: grantedByPrincipalId,
          created_at: Date.now(),
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
  }, input.database);
}
