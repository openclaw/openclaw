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

type AuthorizationProviderDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "authorization_domain_memberships"
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
  const domainIds = new Set(bindings.map((binding) => binding.domain_id));
  if (domainIds.size !== 1) {
    return { allowed: false, reason: "cross-domain" };
  }
  const domainId = [...domainIds][0];
  if (!domainId) {
    return { allowed: false, reason: "indeterminate" };
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
    domain: { id: domainId },
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
