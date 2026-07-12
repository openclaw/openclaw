import { randomUUID } from "node:crypto";
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
import { bindAuthorizationResource, retireAuthorizationResource } from "./state-store.js";

type AuthorizationResourceDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "authorization_domain_memberships"
  | "authorization_delegations"
  | "authorization_principals"
  | "authorization_resource_operations"
  | "authorization_resources"
>;

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}

export type AuthorizationResourceOwner = Readonly<{ principalId: string }>;

export type AuthorizationResourceActor =
  | Readonly<{ kind: "human"; principalId: string }>
  | Readonly<{
      kind: "delegated-agent";
      principalId: string;
      sponsorPrincipalId: string;
      delegationId: string;
      assignmentId: string;
    }>;

export type PreparedAuthorizationResourceOperation = Readonly<{
  operationId: string;
  state: "pending" | "applied";
}>;

function parseOperationState(value: string): PreparedAuthorizationResourceOperation["state"] {
  if (value === "pending" || value === "applied") {
    return value;
  }
  throw new Error("authorization resource operation has an invalid state");
}

function normalizeResource(resource: GatewayResourceRef): GatewayResourceRef {
  return {
    namespace: requiredIdentifier(resource.namespace, "resource namespace"),
    type: requiredIdentifier(resource.type, "resource type"),
    id: requiredIdentifier(resource.id, "resource id"),
  };
}

function sameRegistrationIntent(
  existing: {
    operation_type: string;
    domain_id: string;
    namespace: string;
    resource_type: string;
    resource_id: string;
    parent_namespace: string | null;
    parent_resource_type: string | null;
    parent_resource_id: string | null;
    actor_principal_id: string;
    owner_principal_id: string;
    delegation_id: string | null;
    assignment_id: string | null;
  },
  expected: {
    domainId: string;
    resource: GatewayResourceRef;
    parent?: GatewayResourceRef;
    actorPrincipalId: string;
    ownerPrincipalId: string;
    delegationId?: string;
    assignmentId?: string;
  },
): boolean {
  return (
    existing.operation_type === "register" &&
    existing.domain_id === expected.domainId &&
    existing.namespace === expected.resource.namespace &&
    existing.resource_type === expected.resource.type &&
    existing.resource_id === expected.resource.id &&
    existing.parent_namespace === (expected.parent?.namespace ?? null) &&
    existing.parent_resource_type === (expected.parent?.type ?? null) &&
    existing.parent_resource_id === (expected.parent?.id ?? null) &&
    existing.actor_principal_id === expected.actorPrincipalId &&
    existing.owner_principal_id === expected.ownerPrincipalId &&
    existing.delegation_id === (expected.delegationId ?? null) &&
    existing.assignment_id === (expected.assignmentId ?? null)
  );
}

function hasActiveAuthorizationDelegation(
  db: DatabaseSync,
  input: {
    domainId: string;
    delegationId: string;
    assignmentId: string;
    agentPrincipalId: string;
    sponsorPrincipalId: string;
  },
): boolean {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<AuthorizationResourceDatabase>(db)
      .selectFrom("authorization_delegations as delegation")
      .innerJoin("authorization_domain_memberships as agent_membership", (join) =>
        join
          .onRef("agent_membership.domain_id", "=", "delegation.domain_id")
          .onRef("agent_membership.principal_id", "=", "delegation.agent_principal_id"),
      )
      .innerJoin("authorization_domain_memberships as sponsor_membership", (join) =>
        join
          .onRef("sponsor_membership.domain_id", "=", "delegation.domain_id")
          .onRef("sponsor_membership.principal_id", "=", "delegation.sponsor_principal_id"),
      )
      .select("delegation.delegation_id")
      .where("delegation.domain_id", "=", input.domainId)
      .where("delegation.delegation_id", "=", input.delegationId)
      .where("delegation.assignment_id", "=", input.assignmentId)
      .where("delegation.agent_principal_id", "=", input.agentPrincipalId)
      .where("delegation.sponsor_principal_id", "=", input.sponsorPrincipalId)
      .where("delegation.state", "=", "active"),
  );
  return Boolean(row);
}

function hasHumanDomainMembership(
  db: DatabaseSync,
  domainId: string,
  principalId: string,
): boolean {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<AuthorizationResourceDatabase>(db)
      .selectFrom("authorization_domain_memberships as membership")
      .innerJoin(
        "authorization_principals as principal",
        "principal.principal_id",
        "membership.principal_id",
      )
      .select("membership.principal_id")
      .where("membership.domain_id", "=", domainId)
      .where("membership.principal_id", "=", principalId)
      .where("principal.kind", "=", "human"),
  );
  return Boolean(row);
}

export function prepareAuthorizationResourceRegistration(input: {
  database?: OpenClawStateDatabaseOptions;
  operationScope: string;
  idempotencyKey: string;
  domainId: string;
  resource: GatewayResourceRef;
  parent?: GatewayResourceRef;
  actor: AuthorizationResourceActor;
}): PreparedAuthorizationResourceOperation {
  const operationScope = requiredIdentifier(input.operationScope, "authorization operation scope");
  const idempotencyKey = requiredIdentifier(input.idempotencyKey, "authorization idempotency key");
  const domainId = requiredIdentifier(input.domainId, "isolation domain id");
  const resource = normalizeResource(input.resource);
  const parent = input.parent ? normalizeResource(input.parent) : undefined;
  const actorPrincipalId = requiredIdentifier(input.actor.principalId, "actor principal id");
  const ownerPrincipalId =
    input.actor.kind === "human"
      ? actorPrincipalId
      : requiredIdentifier(input.actor.sponsorPrincipalId, "sponsor principal id");
  const delegationId =
    input.actor.kind === "delegated-agent"
      ? requiredIdentifier(input.actor.delegationId, "delegation id")
      : undefined;
  const assignmentId =
    input.actor.kind === "delegated-agent"
      ? requiredIdentifier(input.actor.assignmentId, "assignment id")
      : undefined;
  return runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<AuthorizationResourceDatabase>(db);
    const existing = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_resource_operations")
        .selectAll()
        .where("domain_id", "=", domainId)
        .where("operation_scope", "=", operationScope)
        .where("idempotency_key", "=", idempotencyKey),
    );
    const expected = {
      domainId,
      resource,
      parent,
      actorPrincipalId,
      ownerPrincipalId,
      delegationId,
      assignmentId,
    };
    if (existing) {
      if (!sameRegistrationIntent(existing, expected)) {
        throw new Error("authorization idempotency key is already bound to another operation");
      }
      return { operationId: existing.operation_id, state: parseOperationState(existing.state) };
    }
    const actor = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_principals as principal")
        .innerJoin("authorization_domain_memberships as membership", (join) =>
          join
            .onRef("membership.principal_id", "=", "principal.principal_id")
            .on("membership.domain_id", "=", domainId),
        )
        .select("principal.kind")
        .where("principal.principal_id", "=", actorPrincipalId),
    );
    const expectedActorKind = input.actor.kind === "human" ? "human" : "service";
    if (actor?.kind !== expectedActorKind) {
      throw new Error(`authorization resource actor must be a ${expectedActorKind} domain member`);
    }
    const owner = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_principals as principal")
        .innerJoin("authorization_domain_memberships as membership", (join) =>
          join
            .onRef("membership.principal_id", "=", "principal.principal_id")
            .on("membership.domain_id", "=", domainId),
        )
        .select("principal.kind")
        .where("principal.principal_id", "=", ownerPrincipalId),
    );
    if (owner?.kind !== "human") {
      throw new Error("authorization resource owner must be a human domain member");
    }
    if (
      input.actor.kind === "delegated-agent" &&
      !hasActiveAuthorizationDelegation(db, {
        domainId,
        delegationId: delegationId!,
        assignmentId: assignmentId!,
        agentPrincipalId: actorPrincipalId,
        sponsorPrincipalId: ownerPrincipalId,
      })
    ) {
      throw new Error("authorization delegation is not active for this agent and sponsor");
    }
    const operationId = `authop_${randomUUID()}`;
    const now = Date.now();
    executeSqliteQuerySync(
      db,
      kysely.insertInto("authorization_resource_operations").values({
        operation_id: operationId,
        operation_scope: operationScope,
        idempotency_key: idempotencyKey,
        operation_type: "register",
        domain_id: domainId,
        namespace: resource.namespace,
        resource_type: resource.type,
        resource_id: resource.id,
        parent_namespace: parent?.namespace ?? null,
        parent_resource_type: parent?.type ?? null,
        parent_resource_id: parent?.id ?? null,
        actor_principal_id: actorPrincipalId,
        owner_principal_id: ownerPrincipalId,
        delegation_id: delegationId ?? null,
        assignment_id: assignmentId ?? null,
        state: "pending",
        created_at: now,
        updated_at: now,
        applied_at: null,
      }),
    );
    return { operationId, state: "pending" };
  }, input.database);
}

export function prepareAuthorizationResourceRetirement(input: {
  database?: OpenClawStateDatabaseOptions;
  operationScope: string;
  idempotencyKey: string;
  domainId: string;
  resource: GatewayResourceRef;
  actorPrincipalId: string;
}): PreparedAuthorizationResourceOperation {
  const operationScope = requiredIdentifier(input.operationScope, "authorization operation scope");
  const idempotencyKey = requiredIdentifier(input.idempotencyKey, "authorization idempotency key");
  const domainId = requiredIdentifier(input.domainId, "isolation domain id");
  const resource = normalizeResource(input.resource);
  const actorPrincipalId = requiredIdentifier(input.actorPrincipalId, "actor principal id");
  return runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<AuthorizationResourceDatabase>(db);
    const existing = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_resource_operations")
        .selectAll()
        .where("domain_id", "=", domainId)
        .where("operation_scope", "=", operationScope)
        .where("idempotency_key", "=", idempotencyKey),
    );
    if (existing) {
      const matches =
        existing.operation_type === "retire" &&
        existing.domain_id === domainId &&
        existing.namespace === resource.namespace &&
        existing.resource_type === resource.type &&
        existing.resource_id === resource.id &&
        existing.actor_principal_id === actorPrincipalId &&
        existing.parent_namespace === null &&
        existing.parent_resource_type === null &&
        existing.parent_resource_id === null &&
        existing.delegation_id === null &&
        existing.assignment_id === null;
      if (!matches) {
        throw new Error("authorization idempotency key is already bound to another operation");
      }
      return { operationId: existing.operation_id, state: parseOperationState(existing.state) };
    }
    const owner = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_resources")
        .select("owner_principal_id")
        .where("domain_id", "=", domainId)
        .where("namespace", "=", resource.namespace)
        .where("resource_type", "=", resource.type)
        .where("resource_id", "=", resource.id)
        .where("retired_at", "is", null),
    );
    if (!owner) {
      throw new Error("authorization resource must be active for retirement");
    }
    const actor = executeSqliteQueryTakeFirstSync(
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
        .where("membership.principal_id", "=", actorPrincipalId),
    );
    if (
      actor?.kind !== "human" ||
      (actor.role !== "owner" && owner.owner_principal_id !== actorPrincipalId)
    ) {
      throw new Error(
        "authorization resource retirement requires its human resource or domain owner",
      );
    }
    const operationId = `authop_${randomUUID()}`;
    const now = Date.now();
    executeSqliteQuerySync(
      db,
      kysely.insertInto("authorization_resource_operations").values({
        operation_id: operationId,
        operation_scope: operationScope,
        idempotency_key: idempotencyKey,
        operation_type: "retire",
        domain_id: domainId,
        namespace: resource.namespace,
        resource_type: resource.type,
        resource_id: resource.id,
        parent_namespace: null,
        parent_resource_type: null,
        parent_resource_id: null,
        actor_principal_id: actorPrincipalId,
        owner_principal_id: owner.owner_principal_id,
        delegation_id: null,
        assignment_id: null,
        state: "pending",
        created_at: now,
        updated_at: now,
        applied_at: null,
      }),
    );
    return { operationId, state: "pending" };
  }, input.database);
}

export function replayAuthorizationResourceOperation(input: {
  database?: OpenClawStateDatabaseOptions;
  domainId: string;
  operationScope: string;
  operationId: string;
}): PreparedAuthorizationResourceOperation {
  const operationScope = requiredIdentifier(input.operationScope, "authorization operation scope");
  const operationId = requiredIdentifier(input.operationId, "authorization operation id");
  const domainId = requiredIdentifier(input.domainId, "isolation domain id");
  return runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<AuthorizationResourceDatabase>(db);
    const operation = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_resource_operations")
        .selectAll()
        .where("domain_id", "=", domainId)
        .where("operation_id", "=", operationId)
        .where("operation_scope", "=", operationScope),
    );
    if (!operation) {
      throw new Error("unknown authorization resource operation");
    }
    if (operation.state === "applied") {
      return { operationId, state: "applied" };
    }
    if (
      operation.delegation_id &&
      operation.assignment_id &&
      !hasActiveAuthorizationDelegation(db, {
        domainId: operation.domain_id,
        delegationId: operation.delegation_id,
        assignmentId: operation.assignment_id,
        agentPrincipalId: operation.actor_principal_id,
        sponsorPrincipalId: operation.owner_principal_id,
      })
    ) {
      throw new Error("authorization delegation is not active for replay");
    }
    if (
      operation.operation_type === "register" &&
      !operation.delegation_id &&
      (operation.actor_principal_id !== operation.owner_principal_id ||
        !hasHumanDomainMembership(db, operation.domain_id, operation.actor_principal_id))
    ) {
      throw new Error("authorization registration requires its active human actor-owner");
    }
    const resource = {
      namespace: operation.namespace,
      type: operation.resource_type,
      id: operation.resource_id,
    };
    if (operation.operation_type === "register") {
      bindAuthorizationResource({
        domainId: operation.domain_id,
        resource,
        ...(operation.parent_namespace &&
        operation.parent_resource_type &&
        operation.parent_resource_id
          ? {
              parent: {
                namespace: operation.parent_namespace,
                type: operation.parent_resource_type,
                id: operation.parent_resource_id,
              },
            }
          : {}),
        ownerPrincipalId: operation.owner_principal_id,
        database: input.database,
      });
    } else if (operation.operation_type === "retire") {
      retireAuthorizationResource({
        domainId: operation.domain_id,
        resource,
        retiredByPrincipalId: operation.actor_principal_id,
        database: input.database,
      });
    } else {
      throw new Error("unsupported authorization resource operation");
    }
    const now = Date.now();
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("authorization_resource_operations")
        .set({ state: "applied", applied_at: now, updated_at: now })
        .where("operation_id", "=", operationId)
        .where("operation_scope", "=", operationScope)
        .where("state", "=", "pending"),
    );
    return { operationId, state: "applied" };
  }, input.database);
}

/** Host-only replay path: plugin scope is loader-bound and the persisted operation resolves domain. */
export function replayAuthorizationResourceOperationForHost(input: {
  database?: OpenClawStateDatabaseOptions;
  operationScope: string;
  operationId: string;
}): PreparedAuthorizationResourceOperation {
  const operationScope = requiredIdentifier(input.operationScope, "authorization operation scope");
  const operationId = requiredIdentifier(input.operationId, "authorization operation id");
  const { db } = openOpenClawStateDatabase(input.database);
  const operation = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<AuthorizationResourceDatabase>(db)
      .selectFrom("authorization_resource_operations")
      .select("domain_id")
      .where("operation_id", "=", operationId)
      .where("operation_scope", "=", operationScope),
  );
  if (!operation) {
    throw new Error("unknown authorization resource operation");
  }
  return replayAuthorizationResourceOperation({
    domainId: operation.domain_id,
    operationScope,
    operationId,
    database: input.database,
  });
}

export function getAuthorizationResourceOwner(input: {
  database?: OpenClawStateDatabaseOptions;
  domainId: string;
  resource: GatewayResourceRef;
}): AuthorizationResourceOwner | undefined {
  const domainId = requiredIdentifier(input.domainId, "isolation domain id");
  const namespace = requiredIdentifier(input.resource.namespace, "resource namespace");
  const type = requiredIdentifier(input.resource.type, "resource type");
  const id = requiredIdentifier(input.resource.id, "resource id");
  const { db } = openOpenClawStateDatabase(input.database);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<AuthorizationResourceDatabase>(db)
      .selectFrom("authorization_resources")
      .select("owner_principal_id")
      .where("domain_id", "=", domainId)
      .where("namespace", "=", namespace)
      .where("resource_type", "=", type)
      .where("resource_id", "=", id)
      .where("retired_at", "is", null),
  );
  return row ? { principalId: row.owner_principal_id } : undefined;
}
