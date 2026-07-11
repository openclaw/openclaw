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
  if (membership?.role !== "owner" || membership.kind !== "human") {
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
      .innerJoin(
        "authorization_principals as principal",
        "principal.principal_id",
        "membership.principal_id",
      )
      .leftJoin("authorization_resources as resource", (join) =>
        join
          .onRef("resource.domain_id", "=", "membership.domain_id")
          .on("resource.namespace", "=", params.resource.namespace)
          .on("resource.resource_type", "=", params.resource.type)
          .on("resource.resource_id", "=", params.resource.id),
      )
      .select(["membership.role", "principal.kind", "resource.owner_principal_id"])
      .where("membership.domain_id", "=", params.domainId)
      .where("membership.principal_id", "=", params.principalId),
  );
  if (
    ownership?.kind !== "human" ||
    (ownership.role !== "owner" && ownership.owner_principal_id !== params.principalId)
  ) {
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
    parent?: GatewayResourceRef;
    ownerPrincipalId: string;
  },
): void {
  const domainId = requiredIdentifier(input.domainId, "isolation domain id");
  const resource = normalizeResource(input.resource);
  const parent = input.parent ? normalizeResource(input.parent) : undefined;
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
        .select([
          "domain_id",
          "owner_principal_id",
          "parent_namespace",
          "parent_resource_type",
          "parent_resource_id",
          "retired_at",
        ])
        .where("domain_id", "=", domainId)
        .where("namespace", "=", resource.namespace)
        .where("resource_type", "=", resource.type)
        .where("resource_id", "=", resource.id),
    );
    if (existing) {
      const sameParent = parent
        ? existing.parent_namespace === parent.namespace &&
          existing.parent_resource_type === parent.type &&
          existing.parent_resource_id === parent.id
        : existing.parent_namespace === null &&
          existing.parent_resource_type === null &&
          existing.parent_resource_id === null;
      if (
        existing.retired_at !== null ||
        existing.owner_principal_id !== ownerPrincipalId ||
        !sameParent
      ) {
        throw new Error("authorization resource is already bound differently");
      }
      return;
    }
    requireHumanDomainMember(db, domainId, ownerPrincipalId);
    if (parent) {
      const parentRow = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("authorization_resources")
          .select(["domain_id", "retired_at"])
          .where("domain_id", "=", domainId)
          .where("namespace", "=", parent.namespace)
          .where("resource_type", "=", parent.type)
          .where("resource_id", "=", parent.id),
      );
      if (!parentRow || parentRow.retired_at !== null) {
        throw new Error("authorization resource parent must be active in the same domain");
      }
    }
    const now = Date.now();
    executeSqliteQuerySync(
      db,
      kysely.insertInto("authorization_resources").values({
        namespace: resource.namespace,
        resource_type: resource.type,
        resource_id: resource.id,
        domain_id: domainId,
        owner_principal_id: ownerPrincipalId,
        parent_namespace: parent?.namespace ?? null,
        parent_resource_type: parent?.type ?? null,
        parent_resource_id: parent?.id ?? null,
        retired_at: null,
        created_at: now,
        updated_at: now,
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

export function revokeAuthorizationPermission(
  input: AuthorizationDatabaseInput & {
    domainId: string;
    principalId: string;
    resource: GatewayResourceRef;
    permission: string;
    revokedByPrincipalId: string;
  },
): void {
  const domainId = requiredIdentifier(input.domainId, "isolation domain id");
  const principalId = requiredIdentifier(input.principalId, "grantee principal id");
  const resource = normalizeResource(input.resource);
  const permission = requiredIdentifier(input.permission, "authorization permission");
  const revokedByPrincipalId = requiredIdentifier(
    input.revokedByPrincipalId,
    "revoking principal id",
  );
  runOpenClawStateWriteTransaction(({ db }) => {
    requireDomainOrResourceOwner({
      db,
      domainId,
      principalId: revokedByPrincipalId,
      resource,
    });
    executeSqliteQuerySync(
      db,
      getAuthorizationKysely(db)
        .deleteFrom("authorization_grants")
        .where("domain_id", "=", domainId)
        .where("principal_id", "=", principalId)
        .where("namespace", "=", resource.namespace)
        .where("resource_type", "=", resource.type)
        .where("resource_id", "=", resource.id)
        .where("permission", "=", permission),
    );
  }, input.database);
}

export function retireAuthorizationResource(
  input: AuthorizationDatabaseInput & {
    domainId: string;
    resource: GatewayResourceRef;
    retiredByPrincipalId: string;
  },
): void {
  const domainId = requiredIdentifier(input.domainId, "isolation domain id");
  const resource = normalizeResource(input.resource);
  const retiredByPrincipalId = requiredIdentifier(
    input.retiredByPrincipalId,
    "retiring principal id",
  );
  runOpenClawStateWriteTransaction(({ db }) => {
    requireDomainOrResourceOwner({
      db,
      domainId,
      principalId: retiredByPrincipalId,
      resource,
    });
    const kysely = getAuthorizationKysely(db);
    const existing = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_resources")
        .select("retired_at")
        .where("domain_id", "=", domainId)
        .where("namespace", "=", resource.namespace)
        .where("resource_type", "=", resource.type)
        .where("resource_id", "=", resource.id),
    );
    if (!existing) {
      throw new Error("unknown authorization resource");
    }
    if (existing.retired_at !== null) {
      return;
    }
    const activeChild = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_resources")
        .select("resource_id")
        .where("domain_id", "=", domainId)
        .where("parent_namespace", "=", resource.namespace)
        .where("parent_resource_type", "=", resource.type)
        .where("parent_resource_id", "=", resource.id)
        .where("retired_at", "is", null)
        .limit(1),
    );
    if (activeChild) {
      throw new Error("authorization resource has an active child resource");
    }
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("authorization_grants")
        .where("domain_id", "=", domainId)
        .where("namespace", "=", resource.namespace)
        .where("resource_type", "=", resource.type)
        .where("resource_id", "=", resource.id),
    );
    const now = Date.now();
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("authorization_resources")
        .set({ retired_at: now, updated_at: now })
        .where("domain_id", "=", domainId)
        .where("namespace", "=", resource.namespace)
        .where("resource_type", "=", resource.type)
        .where("resource_id", "=", resource.id),
    );
  }, input.database);
}

export function transferAuthorizationResourceOwner(
  input: AuthorizationDatabaseInput & {
    domainId: string;
    resource: GatewayResourceRef;
    transferredByPrincipalId: string;
    newOwnerPrincipalId: string;
  },
): void {
  const domainId = requiredIdentifier(input.domainId, "isolation domain id");
  const resource = normalizeResource(input.resource);
  const transferredByPrincipalId = requiredIdentifier(
    input.transferredByPrincipalId,
    "transferring principal id",
  );
  const newOwnerPrincipalId = requiredIdentifier(
    input.newOwnerPrincipalId,
    "new resource owner principal id",
  );
  runOpenClawStateWriteTransaction(({ db }) => {
    requireDomainOrResourceOwner({
      db,
      domainId,
      principalId: transferredByPrincipalId,
      resource,
    });
    requireHumanDomainMember(db, domainId, newOwnerPrincipalId);
    const kysely = getAuthorizationKysely(db);
    const existing = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_resources")
        .select("retired_at")
        .where("domain_id", "=", domainId)
        .where("namespace", "=", resource.namespace)
        .where("resource_type", "=", resource.type)
        .where("resource_id", "=", resource.id),
    );
    if (!existing || existing.retired_at !== null) {
      throw new Error("authorization resource must be active for owner transfer");
    }
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("authorization_resources")
        .set({ owner_principal_id: newOwnerPrincipalId, updated_at: Date.now() })
        .where("domain_id", "=", domainId)
        .where("namespace", "=", resource.namespace)
        .where("resource_type", "=", resource.type)
        .where("resource_id", "=", resource.id),
    );
  }, input.database);
}

export function removeIsolationDomainMember(
  input: AuthorizationDatabaseInput & {
    domainId: string;
    principalId: string;
    removedByPrincipalId: string;
  },
): void {
  const domainId = requiredIdentifier(input.domainId, "isolation domain id");
  const principalId = requiredIdentifier(input.principalId, "member principal id");
  const removedByPrincipalId = requiredIdentifier(
    input.removedByPrincipalId,
    "removing principal id",
  );
  runOpenClawStateWriteTransaction(({ db }) => {
    requireDomainOwner(db, domainId, removedByPrincipalId);
    const kysely = getAuthorizationKysely(db);
    const membership = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_domain_memberships")
        .select("role")
        .where("domain_id", "=", domainId)
        .where("principal_id", "=", principalId),
    );
    if (!membership) {
      return;
    }
    if (membership.role === "owner") {
      throw new Error("isolation domain owner cannot be removed");
    }
    const activeOwnedResource = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_resources")
        .select("resource_id")
        .where("domain_id", "=", domainId)
        .where("owner_principal_id", "=", principalId)
        .where("retired_at", "is", null)
        .limit(1),
    );
    if (activeOwnedResource) {
      throw new Error("member owns active resource; transfer or retire it before removal");
    }
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("authorization_grants")
        .where("domain_id", "=", domainId)
        .where((eb) =>
          eb.or([
            eb("principal_id", "=", principalId),
            eb("granted_by_principal_id", "=", principalId),
          ]),
        ),
    );
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("authorization_resources")
        .set({ owner_principal_id: removedByPrincipalId, updated_at: Date.now() })
        .where("domain_id", "=", domainId)
        .where("owner_principal_id", "=", principalId)
        .where("retired_at", "is not", null),
    );
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("authorization_domain_memberships")
        .where("domain_id", "=", domainId)
        .where("principal_id", "=", principalId),
    );
  }, input.database);
}

export type AuthorizedResourcePage = Readonly<{
  resources: readonly GatewayResourceRef[];
  nextCursor?: string;
}>;

export function listAuthorizedResources(
  input: AuthorizationDatabaseInput & {
    domainId: string;
    principalId: string;
    namespace: string;
    type: string;
    permission: string;
    cursor?: string;
    limit: number;
  },
): AuthorizedResourcePage {
  const domainId = requiredIdentifier(input.domainId, "isolation domain id");
  const principalId = requiredIdentifier(input.principalId, "principal id");
  const namespace = requiredIdentifier(input.namespace, "resource namespace");
  const type = requiredIdentifier(input.type, "resource type");
  const permission = requiredIdentifier(input.permission, "authorization permission");
  const cursor = input.cursor
    ? requiredIdentifier(input.cursor, "authorization list cursor")
    : undefined;
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error("authorization resource list limit must be an integer from 1 to 100");
  }
  const { db } = openOpenClawStateDatabase(input.database);
  const kysely = getAuthorizationKysely(db);
  const membership = executeSqliteQueryTakeFirstSync(
    db,
    kysely
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
  if (!membership) {
    return { resources: [] };
  }
  let query = kysely
    .selectFrom("authorization_resources as resource")
    .leftJoin("authorization_grants as grant", (join) =>
      join
        .onRef("grant.domain_id", "=", "resource.domain_id")
        .onRef("grant.namespace", "=", "resource.namespace")
        .onRef("grant.resource_type", "=", "resource.resource_type")
        .onRef("grant.resource_id", "=", "resource.resource_id")
        .on("grant.principal_id", "=", principalId)
        .on("grant.permission", "=", permission),
    )
    .select(["resource.namespace", "resource.resource_type", "resource.resource_id"])
    .where("resource.domain_id", "=", domainId)
    .where("resource.namespace", "=", namespace)
    .where("resource.resource_type", "=", type)
    .where("resource.retired_at", "is", null);
  if (cursor) {
    query = query.where("resource.resource_id", ">", cursor);
  }
  if (membership.kind !== "human" || membership.role !== "owner") {
    query = query.where((eb) =>
      eb.or([
        ...(membership.kind === "human"
          ? [eb("resource.owner_principal_id", "=", principalId)]
          : []),
        eb("grant.permission", "is not", null),
      ]),
    );
  }
  const rows = executeSqliteQuerySync(
    db,
    query.orderBy("resource.resource_id", "asc").limit(input.limit + 1),
  ).rows;
  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
  const resources = pageRows.map((row) => ({
    namespace: row.namespace,
    type: row.resource_type,
    id: row.resource_id,
  }));
  return {
    resources,
    ...(hasMore && resources.length > 0 ? { nextCursor: resources[resources.length - 1]?.id } : {}),
  };
}
