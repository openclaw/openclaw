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
  GATEWAY_AGENT_SESSION_INVOKE_PERMISSION,
  type GatewayAuthorizationSubject,
} from "./contracts.js";
import { createStateGatewayAuthorizationRuntime } from "./state-provider.js";

export { GATEWAY_AGENT_SESSION_INVOKE_PERMISSION } from "./contracts.js";

type AuthorizationAgentSessionBindingDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "authorization_agent_session_bindings"
  | "authorization_delegations"
  | "authorization_domain_memberships"
  | "authorization_principals"
  | "authorization_resources"
>;

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}

export function createAuthorizationAgentSessionBinding(input: {
  database?: OpenClawStateDatabaseOptions;
  id: string;
  domainId: string;
  runtimeAgentId: string;
  sessionKey: string;
  delegationId: string;
  assignmentId: string;
  createdByPrincipalId: string;
}): void {
  const bindingId = requiredIdentifier(input.id, "agent session binding id");
  const domainId = requiredIdentifier(input.domainId, "isolation domain id");
  const runtimeAgentId = requiredIdentifier(input.runtimeAgentId, "runtime agent id");
  const sessionKey = requiredIdentifier(input.sessionKey, "session key");
  const delegationId = requiredIdentifier(input.delegationId, "delegation id");
  const assignmentId = requiredIdentifier(input.assignmentId, "assignment id");
  const createdByPrincipalId = requiredIdentifier(
    input.createdByPrincipalId,
    "agent session binding creator principal id",
  );

  runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<AuthorizationAgentSessionBindingDatabase>(db);
    const delegation = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_delegations")
        .select(["agent_principal_id", "sponsor_principal_id", "state"])
        .where("domain_id", "=", domainId)
        .where("delegation_id", "=", delegationId)
        .where("assignment_id", "=", assignmentId),
    );
    if (!delegation || delegation.state !== "active") {
      throw new Error("authorization agent session binding requires an active delegation");
    }
    if (delegation.sponsor_principal_id !== createdByPrincipalId) {
      throw new Error(
        "authorization agent session binding must be created by its canonical human sponsor",
      );
    }
    const resource = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_resources")
        .select("owner_principal_id")
        .where("domain_id", "=", domainId)
        .where("namespace", "=", "core")
        .where("resource_type", "=", "agent-session")
        .where("resource_id", "=", assignmentId)
        .where("retired_at", "is", null),
    );
    if (resource?.owner_principal_id !== delegation.sponsor_principal_id) {
      throw new Error(
        "authorization agent session binding requires its sponsor-owned agent-session resource",
      );
    }

    const byId = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_agent_session_bindings")
        .selectAll()
        .where("domain_id", "=", domainId)
        .where("binding_id", "=", bindingId),
    );
    const byRuntimeIdentity = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_agent_session_bindings")
        .selectAll()
        .where("runtime_agent_id", "=", runtimeAgentId)
        .where("session_key", "=", sessionKey)
        .where("state", "=", "active"),
    );
    const existing = byId ?? byRuntimeIdentity;
    if (existing) {
      if (existing.state === "revoked") {
        throw new Error(
          "authorization agent session binding is revoked; create a new binding identity",
        );
      }
      const matches =
        existing.binding_id === bindingId &&
        existing.domain_id === domainId &&
        existing.runtime_agent_id === runtimeAgentId &&
        existing.session_key === sessionKey &&
        existing.delegation_id === delegationId &&
        existing.assignment_id === assignmentId &&
        existing.agent_principal_id === delegation.agent_principal_id &&
        existing.sponsor_principal_id === delegation.sponsor_principal_id &&
        existing.created_by_principal_id === createdByPrincipalId;
      if (
        !matches ||
        (byId &&
          byRuntimeIdentity &&
          (byId.domain_id !== byRuntimeIdentity.domain_id ||
            byId.binding_id !== byRuntimeIdentity.binding_id))
      ) {
        throw new Error("authorization agent session identity is already bound differently");
      }
      return;
    }

    const now = Date.now();
    executeSqliteQuerySync(
      db,
      kysely.insertInto("authorization_agent_session_bindings").values({
        domain_id: domainId,
        binding_id: bindingId,
        runtime_agent_id: runtimeAgentId,
        session_key: sessionKey,
        delegation_id: delegationId,
        assignment_id: assignmentId,
        agent_principal_id: delegation.agent_principal_id,
        sponsor_principal_id: delegation.sponsor_principal_id,
        created_by_principal_id: createdByPrincipalId,
        state: "active",
        created_at: now,
        updated_at: now,
        revoked_at: null,
      }),
    );
  }, input.database);
}

function resolveGatewayAgentAuthorizationBinding(input: {
  database?: OpenClawStateDatabaseOptions;
  runtimeAgentId: string;
  sessionKey: string;
}): Readonly<{ id: string; subject: GatewayAuthorizationSubject }> | undefined {
  const runtimeAgentId = requiredIdentifier(input.runtimeAgentId, "runtime agent id");
  const sessionKey = requiredIdentifier(input.sessionKey, "session key");
  const db = openOpenClawStateDatabase(input.database).db;
  const kysely = getNodeSqliteKysely<AuthorizationAgentSessionBindingDatabase>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("authorization_agent_session_bindings as binding")
      .innerJoin("authorization_delegations as delegation", (join) =>
        join
          .onRef("delegation.domain_id", "=", "binding.domain_id")
          .onRef("delegation.delegation_id", "=", "binding.delegation_id")
          .onRef("delegation.assignment_id", "=", "binding.assignment_id")
          .onRef("delegation.agent_principal_id", "=", "binding.agent_principal_id")
          .onRef("delegation.sponsor_principal_id", "=", "binding.sponsor_principal_id"),
      )
      .innerJoin("authorization_principals as agent", (join) =>
        join
          .onRef("agent.principal_id", "=", "binding.agent_principal_id")
          .on("agent.kind", "=", "service"),
      )
      .innerJoin("authorization_domain_memberships as agent_membership", (join) =>
        join
          .onRef("agent_membership.domain_id", "=", "binding.domain_id")
          .onRef("agent_membership.principal_id", "=", "binding.agent_principal_id"),
      )
      .innerJoin("authorization_domain_memberships as sponsor_membership", (join) =>
        join
          .onRef("sponsor_membership.domain_id", "=", "binding.domain_id")
          .onRef("sponsor_membership.principal_id", "=", "binding.sponsor_principal_id")
          .on("sponsor_membership.role", "=", "owner"),
      )
      .select([
        "binding.binding_id",
        "binding.domain_id",
        "binding.delegation_id",
        "binding.assignment_id",
        "agent.issuer",
        "agent.subject",
      ])
      .where("binding.runtime_agent_id", "=", runtimeAgentId)
      .where("binding.session_key", "=", sessionKey)
      .where("binding.state", "=", "active")
      .where("delegation.state", "=", "active"),
  );
  if (!row) {
    return undefined;
  }

  const principal = Object.freeze({
    issuer: row.issuer,
    subject: row.subject,
    kind: "service" as const,
  });
  const domain = Object.freeze({ id: row.domain_id });
  const delegation = Object.freeze({
    id: row.delegation_id,
    assignmentId: row.assignment_id,
  });
  return Object.freeze({
    id: row.binding_id,
    subject: Object.freeze({ principal, domain, delegation }),
  });
}

/** Resolves only the exact final runtime agent/session identity selected by the gateway. */
export function resolveGatewayAgentAuthorizationSubject(input: {
  database?: OpenClawStateDatabaseOptions;
  runtimeAgentId: string;
  sessionKey: string;
}): GatewayAuthorizationSubject | undefined {
  return resolveGatewayAgentAuthorizationBinding(input)?.subject;
}

/**
 * Resolves the service subject only after the invoking human is authorized for
 * the exact agent-session assignment resource. The human is an invocation
 * gate; the resulting tool authority remains the bound service principal.
 */
export async function resolveAuthorizedGatewayAgentAuthorizationSubject(input: {
  database?: OpenClawStateDatabaseOptions;
  invokingPrincipal: GatewayPrincipal;
  runtimeAgentId: string;
  sessionKey: string;
}): Promise<GatewayAuthorizationSubject | undefined> {
  if (input.invokingPrincipal.kind !== "human") {
    return undefined;
  }
  const binding = resolveGatewayAgentAuthorizationBinding(input);
  const subject = binding?.subject;
  if (!subject?.delegation) {
    return undefined;
  }
  const runtime = createStateGatewayAuthorizationRuntime({ database: input.database });
  if (runtime.mode !== "isolated") {
    return undefined;
  }
  const decision = await runtime.authorize({
    principal: input.invokingPrincipal,
    domain: subject.domain,
    method: "agent",
    permission: GATEWAY_AGENT_SESSION_INVOKE_PERMISSION,
    resources: [
      {
        namespace: "core",
        type: "agent-session",
        id: subject.delegation.assignmentId,
      },
    ],
  });
  if (!decision.allowed || !binding) {
    return undefined;
  }
  return Object.freeze({
    ...subject,
    agentSession: Object.freeze({
      id: binding.id,
      invokingPrincipal: Object.freeze({
        issuer: input.invokingPrincipal.issuer,
        subject: input.invokingPrincipal.subject,
        kind: input.invokingPrincipal.kind,
      }),
    }),
  });
}

export function revokeAuthorizationAgentSessionBinding(input: {
  database?: OpenClawStateDatabaseOptions;
  domainId: string;
  id: string;
  revokedByPrincipalId: string;
}): void {
  const domainId = requiredIdentifier(input.domainId, "isolation domain id");
  const bindingId = requiredIdentifier(input.id, "agent session binding id");
  const revokedByPrincipalId = requiredIdentifier(
    input.revokedByPrincipalId,
    "revoking principal id",
  );

  runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<AuthorizationAgentSessionBindingDatabase>(db);
    const binding = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_agent_session_bindings")
        .select(["sponsor_principal_id", "state"])
        .where("domain_id", "=", domainId)
        .where("binding_id", "=", bindingId),
    );
    if (!binding) {
      throw new Error("unknown authorization agent session binding");
    }
    if (binding.state === "revoked") {
      return;
    }
    const revoker = executeSqliteQueryTakeFirstSync(
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
        .where("membership.principal_id", "=", revokedByPrincipalId),
    );
    if (
      revoker?.kind !== "human" ||
      (revoker.role !== "owner" && binding.sponsor_principal_id !== revokedByPrincipalId)
    ) {
      throw new Error(
        "authorization agent session binding revocation requires its sponsor or domain owner",
      );
    }
    const now = Date.now();
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("authorization_agent_session_bindings")
        .set({ state: "revoked", revoked_at: now, updated_at: now })
        .where("domain_id", "=", domainId)
        .where("binding_id", "=", bindingId)
        .where("state", "=", "active"),
    );
  }, input.database);
}
