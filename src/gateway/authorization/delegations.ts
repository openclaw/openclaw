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

type AuthorizationDelegationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "authorization_agent_sponsors"
  | "authorization_delegations"
  | "authorization_domain_memberships"
  | "authorization_principals"
>;

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}

export function createAuthorizationDelegation(input: {
  database?: OpenClawStateDatabaseOptions;
  id: string;
  assignmentId: string;
  domainId: string;
  agentPrincipalId: string;
  sponsorPrincipalId: string;
  createdByPrincipalId: string;
}): void {
  const delegationId = requiredIdentifier(input.id, "delegation id");
  const assignmentId = requiredIdentifier(input.assignmentId, "assignment id");
  const domainId = requiredIdentifier(input.domainId, "isolation domain id");
  const agentPrincipalId = requiredIdentifier(input.agentPrincipalId, "agent principal id");
  const sponsorPrincipalId = requiredIdentifier(input.sponsorPrincipalId, "sponsor principal id");
  const createdByPrincipalId = requiredIdentifier(
    input.createdByPrincipalId,
    "delegation creator principal id",
  );
  if (createdByPrincipalId !== sponsorPrincipalId) {
    throw new Error("an authorization delegation must be created by its human sponsor");
  }
  runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<AuthorizationDelegationDatabase>(db);
    const byId = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_delegations")
        .selectAll()
        .where("domain_id", "=", domainId)
        .where("delegation_id", "=", delegationId),
    );
    const byAssignment = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_delegations")
        .selectAll()
        .where("domain_id", "=", domainId)
        .where("assignment_id", "=", assignmentId),
    );
    const existing = byId ?? byAssignment;
    if (existing) {
      const matches =
        existing.delegation_id === delegationId &&
        existing.assignment_id === assignmentId &&
        existing.agent_principal_id === agentPrincipalId &&
        existing.sponsor_principal_id === sponsorPrincipalId &&
        existing.created_by_principal_id === createdByPrincipalId;
      if (!matches || (byId && byAssignment && byId.delegation_id !== byAssignment.delegation_id)) {
        throw new Error("authorization delegation identity is already bound differently");
      }
      return;
    }
    const participants = executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("authorization_principals as principal")
        .innerJoin("authorization_domain_memberships as membership", (join) =>
          join
            .onRef("membership.principal_id", "=", "principal.principal_id")
            .on("membership.domain_id", "=", domainId),
        )
        .select(["principal.principal_id", "principal.kind", "membership.role"])
        .where("principal.principal_id", "in", [agentPrincipalId, sponsorPrincipalId]),
    ).rows;
    const participantsById = new Map(
      participants.map((participant) => [participant.principal_id, participant]),
    );
    if (participantsById.get(agentPrincipalId)?.kind !== "service") {
      throw new Error("authorization delegation agent must be a service domain member");
    }
    const sponsor = participantsById.get(sponsorPrincipalId);
    if (sponsor?.kind !== "human" || sponsor.role !== "owner") {
      throw new Error("authorization delegation canonical sponsor must be the human domain owner");
    }
    const now = Date.now();
    const canonicalSponsor = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_agent_sponsors")
        .select("sponsor_principal_id")
        .where("domain_id", "=", domainId)
        .where("agent_principal_id", "=", agentPrincipalId),
    );
    if (canonicalSponsor && canonicalSponsor.sponsor_principal_id !== sponsorPrincipalId) {
      throw new Error("authorization agent is already tied to a different canonical sponsor");
    }
    if (!canonicalSponsor) {
      executeSqliteQuerySync(
        db,
        kysely.insertInto("authorization_agent_sponsors").values({
          domain_id: domainId,
          agent_principal_id: agentPrincipalId,
          sponsor_principal_id: sponsorPrincipalId,
          created_at: now,
        }),
      );
    }
    executeSqliteQuerySync(
      db,
      kysely.insertInto("authorization_delegations").values({
        domain_id: domainId,
        delegation_id: delegationId,
        assignment_id: assignmentId,
        agent_principal_id: agentPrincipalId,
        sponsor_principal_id: sponsorPrincipalId,
        created_by_principal_id: createdByPrincipalId,
        state: "active",
        created_at: now,
        updated_at: now,
        revoked_at: null,
      }),
    );
  }, input.database);
}

export function revokeAuthorizationDelegation(input: {
  database?: OpenClawStateDatabaseOptions;
  domainId: string;
  delegationId: string;
  revokedByPrincipalId: string;
}): void {
  const domainId = requiredIdentifier(input.domainId, "isolation domain id");
  const delegationId = requiredIdentifier(input.delegationId, "delegation id");
  const revokedByPrincipalId = requiredIdentifier(
    input.revokedByPrincipalId,
    "revoking principal id",
  );
  runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<AuthorizationDelegationDatabase>(db);
    const delegation = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_delegations")
        .select(["sponsor_principal_id", "state"])
        .where("domain_id", "=", domainId)
        .where("delegation_id", "=", delegationId),
    );
    if (!delegation) {
      throw new Error("unknown authorization delegation");
    }
    if (delegation.state === "revoked") {
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
      (revoker.role !== "owner" && delegation.sponsor_principal_id !== revokedByPrincipalId)
    ) {
      throw new Error("authorization delegation revocation requires its sponsor or domain owner");
    }
    const now = Date.now();
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("authorization_delegations")
        .set({ state: "revoked", revoked_at: now, updated_at: now })
        .where("domain_id", "=", domainId)
        .where("delegation_id", "=", delegationId)
        .where("state", "=", "active"),
    );
  }, input.database);
}
