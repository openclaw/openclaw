import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import type {
  GatewayAuthorizationRequest,
  GatewayAuthorizationRuntime,
  GatewayRbacDecision,
  GatewayResourceRef,
} from "./contracts.js";
import { GATEWAY_AGENT_SESSION_INVOKE_PERMISSION } from "./contracts.js";

type AuthorizationProviderDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "authorization_domain_memberships"
  | "authorization_agent_session_bindings"
  | "authorization_delegations"
  | "authorization_grants"
  | "authorization_principals"
  | "authorization_resources"
>;

function resourceKey(resource: GatewayResourceRef): string {
  return JSON.stringify([resource.namespace, resource.type, resource.id]);
}

function authorizeFromState(
  request: GatewayAuthorizationRequest,
  database?: OpenClawStateDatabaseOptions,
): GatewayRbacDecision {
  const db = openOpenClawStateDatabase(database).db;
  const kysely = getNodeSqliteKysely<AuthorizationProviderDatabase>(db);
  const principal = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("authorization_principals")
      .select("principal_id")
      .where("issuer", "=", request.principal.issuer)
      .where("subject", "=", request.principal.subject)
      .where("kind", "=", request.principal.kind),
  );
  if (!principal) {
    return { allowed: false, reason: "unknown-principal" };
  }

  let validatedDelegation:
    | { id: string; assignmentId: string; sponsorPrincipalId: string }
    | undefined;
  if (request.principal.kind === "service") {
    if (!request.delegation) {
      return { allowed: false, reason: "forbidden" };
    }
    const delegation = executeSqliteQueryTakeFirstSync(
      db,
      kysely
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
        .select("delegation.sponsor_principal_id")
        .where("delegation.domain_id", "=", request.domain.id)
        .where("delegation.delegation_id", "=", request.delegation.id)
        .where("delegation.assignment_id", "=", request.delegation.assignmentId)
        .where("delegation.agent_principal_id", "=", principal.principal_id)
        .where("delegation.state", "=", "active")
        .where("sponsor_membership.role", "=", "owner"),
    );
    if (!delegation) {
      return { allowed: false, reason: "forbidden" };
    }
    validatedDelegation = {
      id: request.delegation.id,
      assignmentId: request.delegation.assignmentId,
      sponsorPrincipalId: delegation.sponsor_principal_id,
    };
    if (request.agentSession) {
      if (request.agentSession.invokingPrincipal.kind !== "human") {
        return { allowed: false, reason: "forbidden" };
      }
      const binding = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("authorization_agent_session_bindings")
          .select("binding_id")
          .where("domain_id", "=", request.domain.id)
          .where("binding_id", "=", request.agentSession.id)
          .where("delegation_id", "=", request.delegation.id)
          .where("assignment_id", "=", request.delegation.assignmentId)
          .where("agent_principal_id", "=", principal.principal_id)
          .where("sponsor_principal_id", "=", delegation.sponsor_principal_id)
          .where("state", "=", "active"),
      );
      if (!binding) {
        return { allowed: false, reason: "forbidden" };
      }
      const invocationDecision = authorizeFromState(
        {
          principal: request.agentSession.invokingPrincipal,
          domain: request.domain,
          method: "agent",
          permission: GATEWAY_AGENT_SESSION_INVOKE_PERMISSION,
          resources: [
            {
              namespace: "core",
              type: "agent-session",
              id: request.delegation.assignmentId,
            },
          ],
        },
        database,
      );
      if (!invocationDecision.allowed) {
        return { allowed: false, reason: "forbidden" };
      }
    }
  } else if (request.delegation) {
    return { allowed: false, reason: "forbidden" };
  } else if (request.agentSession) {
    return { allowed: false, reason: "forbidden" };
  }

  const resources = [
    ...new Map(request.resources.map((resource) => [resourceKey(resource), resource])).values(),
  ];
  const bindings = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("authorization_resources as resource")
      .leftJoin("authorization_domain_memberships as membership", (join) =>
        join
          .onRef("membership.domain_id", "=", "resource.domain_id")
          .on("membership.principal_id", "=", principal.principal_id),
      )
      .leftJoin("authorization_grants as grant", (join) =>
        join
          .onRef("grant.domain_id", "=", "resource.domain_id")
          .onRef("grant.namespace", "=", "resource.namespace")
          .onRef("grant.resource_type", "=", "resource.resource_type")
          .onRef("grant.resource_id", "=", "resource.resource_id")
          .on("grant.principal_id", "=", principal.principal_id)
          .on("grant.permission", "=", request.permission),
      )
      .select([
        "resource.namespace",
        "resource.resource_type",
        "resource.resource_id",
        "resource.domain_id",
        "resource.owner_principal_id",
        "membership.role as membership_role",
        "grant.permission as granted_permission",
      ])
      .where("resource.domain_id", "=", request.domain.id)
      .where("resource.retired_at", "is", null)
      .where((eb) =>
        eb.or(
          resources.map((resource) =>
            eb.and([
              eb("resource.namespace", "=", resource.namespace),
              eb("resource.resource_type", "=", resource.type),
              eb("resource.resource_id", "=", resource.id),
            ]),
          ),
        ),
      ),
  ).rows;
  if (bindings.length !== resources.length) {
    return { allowed: false, reason: "unbound-resource" };
  }
  if (bindings.some((binding) => !binding.membership_role)) {
    return { allowed: false, reason: "cross-domain" };
  }
  if (
    bindings.some(
      (binding) =>
        (request.principal.kind !== "human" ||
          (binding.membership_role !== "owner" &&
            binding.owner_principal_id !== principal.principal_id)) &&
        !binding.granted_permission,
    )
  ) {
    return { allowed: false, reason: "forbidden" };
  }
  return {
    allowed: true,
    principalId: principal.principal_id,
    domain: request.domain,
    ...(validatedDelegation ? { delegation: validatedDelegation } : {}),
  };
}

export function createStateGatewayAuthorizationRuntime(
  options: {
    database?: OpenClawStateDatabaseOptions;
  } = {},
): GatewayAuthorizationRuntime {
  return {
    mode: "isolated",
    authorize: async (request) => authorizeFromState(request, options.database),
  };
}
