import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
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
import type { TeamsLocalAccount } from "./teams-identity.js";
import { normalizeTeamsLoginLabel, prepareTeamsPassword } from "./teams-password.js";

type TeamsBootstrapDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "authorization_agent_session_bindings"
  | "authorization_agent_sponsors"
  | "authorization_delegations"
  | "authorization_domain_memberships"
  | "authorization_domains"
  | "authorization_grants"
  | "authorization_principals"
  | "authorization_resources"
  | "teams_local_accounts"
>;

type DatabaseInput = { database?: OpenClawStateDatabaseOptions };

const DEFAULT_DOMAIN_ID = "openclaw-local";
const INITIAL_WORKSPACE = Object.freeze({
  namespace: "workspaces",
  type: "workspace",
  id: "default",
});
const INITIAL_TAB = Object.freeze({ namespace: "workspaces", type: "tab", id: "main" });
const MAIN_AGENT = Object.freeze({
  issuer: "openclaw-core",
  subject: "agent:main",
  runtimeAgentId: "main",
  sessionKey: "agent:main:main",
  assignmentId: "main:main",
});
const MAIN_AGENT_SESSION = Object.freeze({
  namespace: "core",
  type: "agent-session",
  id: MAIN_AGENT.assignmentId,
});

export type TeamsBootstrapResult = Readonly<{
  account: TeamsLocalAccount;
  agent: Readonly<{
    principalId: string;
    runtimeAgentId: string;
    sessionKey: string;
    assignmentId: string;
  }>;
  domainId: string;
}>;

function getTeamsBootstrapKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<TeamsBootstrapDatabase>(db);
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}

function assertExistingBootstrap(input: {
  db: DatabaseSync;
  domainId: string;
  account: { account_id: string; principal_id: string; login_label: string; created_at: number };
}): TeamsBootstrapResult {
  const kysely = getTeamsBootstrapKysely(input.db);
  const principal = executeSqliteQueryTakeFirstSync(
    input.db,
    kysely
      .selectFrom("authorization_principals")
      .select(["issuer", "subject", "kind"])
      .where("principal_id", "=", input.account.principal_id),
  );
  if (
    principal?.issuer !== "openclaw-local" ||
    principal.subject !== input.account.login_label ||
    principal.kind !== "human"
  ) {
    throw new Error("Teams bootstrap account is mapped to a different principal identity");
  }
  const membership = executeSqliteQueryTakeFirstSync(
    input.db,
    kysely
      .selectFrom("authorization_domain_memberships")
      .select("role")
      .where("domain_id", "=", input.domainId)
      .where("principal_id", "=", input.account.principal_id),
  );
  if (membership?.role !== "owner") {
    throw new Error("Teams bootstrap domain is already owned differently");
  }
  const agent = executeSqliteQueryTakeFirstSync(
    input.db,
    kysely
      .selectFrom("authorization_principals")
      .select(["principal_id", "kind"])
      .where("issuer", "=", MAIN_AGENT.issuer)
      .where("subject", "=", MAIN_AGENT.subject),
  );
  if (agent?.kind !== "service") {
    throw new Error("Teams bootstrap main agent principal is unavailable");
  }
  const agentMembership = executeSqliteQueryTakeFirstSync(
    input.db,
    kysely
      .selectFrom("authorization_domain_memberships")
      .select("role")
      .where("domain_id", "=", input.domainId)
      .where("principal_id", "=", agent.principal_id),
  );
  if (agentMembership?.role !== "member") {
    throw new Error("Teams bootstrap main agent membership is unavailable");
  }
  for (const resource of [INITIAL_WORKSPACE, INITIAL_TAB, MAIN_AGENT_SESSION]) {
    const row = executeSqliteQueryTakeFirstSync(
      input.db,
      kysely
        .selectFrom("authorization_resources")
        .select([
          "owner_principal_id",
          "parent_namespace",
          "parent_resource_type",
          "parent_resource_id",
          "retired_at",
        ])
        .where("domain_id", "=", input.domainId)
        .where("namespace", "=", resource.namespace)
        .where("resource_type", "=", resource.type)
        .where("resource_id", "=", resource.id),
    );
    const isTab = resource === INITIAL_TAB;
    const hasExpectedParent = !isTab
      ? row?.parent_namespace === null &&
        row.parent_resource_type === null &&
        row.parent_resource_id === null
      : row?.parent_namespace === INITIAL_WORKSPACE.namespace &&
        row.parent_resource_type === INITIAL_WORKSPACE.type &&
        row.parent_resource_id === INITIAL_WORKSPACE.id;
    if (
      row?.owner_principal_id !== input.account.principal_id ||
      row.retired_at !== null ||
      !hasExpectedParent
    ) {
      throw new Error("Teams bootstrap resources are already bound differently");
    }
  }
  const binding = executeSqliteQueryTakeFirstSync(
    input.db,
    kysely
      .selectFrom("authorization_agent_session_bindings")
      .select(["agent_principal_id", "sponsor_principal_id", "state"])
      .where("domain_id", "=", input.domainId)
      .where("binding_id", "=", MAIN_AGENT.assignmentId)
      .where("runtime_agent_id", "=", MAIN_AGENT.runtimeAgentId)
      .where("session_key", "=", MAIN_AGENT.sessionKey),
  );
  if (
    binding?.agent_principal_id !== agent.principal_id ||
    binding.sponsor_principal_id !== input.account.principal_id ||
    binding.state !== "active"
  ) {
    throw new Error("Teams bootstrap main agent binding is unavailable");
  }
  return Object.freeze({
    account: Object.freeze({
      id: input.account.account_id,
      principalId: input.account.principal_id,
      loginLabel: input.account.login_label,
      createdAt: input.account.created_at,
    }),
    agent: Object.freeze({
      principalId: agent.principal_id,
      runtimeAgentId: MAIN_AGENT.runtimeAgentId,
      sessionKey: MAIN_AGENT.sessionKey,
      assignmentId: MAIN_AGENT.assignmentId,
    }),
    domainId: input.domainId,
  });
}

/** Create the initial local human owner and the workspace tree in one state transaction. */
export async function bootstrapTeamsOwner(
  input: DatabaseInput & {
    loginLabel: string;
    password: string;
    domainId?: string;
    now?: number;
  },
): Promise<TeamsBootstrapResult> {
  const loginLabel = normalizeTeamsLoginLabel(input.loginLabel);
  const domainId = requiredIdentifier(
    input.domainId ?? DEFAULT_DOMAIN_ID,
    "Teams bootstrap domain id",
  );
  // Scrypt is intentionally outside the SQLite transaction; a slow verifier must not hold the write lock.
  const password = await prepareTeamsPassword(input.password);
  const principalId = randomUUID();
  const agentPrincipalId = randomUUID();
  const accountId = randomUUID();
  const now = input.now ?? Date.now();

  return runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getTeamsBootstrapKysely(db);
    const existingAccount = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("teams_local_accounts")
        .select(["account_id", "principal_id", "login_label", "created_at"])
        .where("login_label", "=", loginLabel),
    );
    if (existingAccount) {
      return assertExistingBootstrap({ db, domainId, account: existingAccount });
    }
    const existingPrincipal = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_principals")
        .select("principal_id")
        .where("issuer", "=", "openclaw-local")
        .where("subject", "=", loginLabel)
        .where("kind", "=", "human"),
    );
    if (existingPrincipal) {
      throw new Error("Teams bootstrap principal is already mapped without its local account");
    }
    const existingDomain = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("authorization_domains")
        .select("domain_id")
        .where("domain_id", "=", domainId),
    );
    if (existingDomain) {
      throw new Error("Teams bootstrap domain already belongs to another owner");
    }

    executeSqliteQuerySync(
      db,
      kysely.insertInto("authorization_principals").values({
        principal_id: principalId,
        issuer: "openclaw-local",
        subject: loginLabel,
        kind: "human",
        created_at: now,
        updated_at: now,
      }),
    );
    executeSqliteQuerySync(
      db,
      kysely.insertInto("authorization_principals").values({
        principal_id: agentPrincipalId,
        issuer: MAIN_AGENT.issuer,
        subject: MAIN_AGENT.subject,
        kind: "service",
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
        principal_id: principalId,
        role: "owner",
        added_by_principal_id: principalId,
        added_by_role: "owner",
        created_at: now,
      }),
    );
    executeSqliteQuerySync(
      db,
      kysely.insertInto("authorization_domain_memberships").values({
        domain_id: domainId,
        principal_id: agentPrincipalId,
        role: "member",
        added_by_principal_id: principalId,
        added_by_role: "owner",
        created_at: now,
      }),
    );
    for (const [resource, parent] of [
      [INITIAL_WORKSPACE, null],
      [INITIAL_TAB, INITIAL_WORKSPACE],
      [MAIN_AGENT_SESSION, null],
    ] as const) {
      executeSqliteQuerySync(
        db,
        kysely.insertInto("authorization_resources").values({
          namespace: resource.namespace,
          resource_type: resource.type,
          resource_id: resource.id,
          domain_id: domainId,
          owner_principal_id: principalId,
          parent_namespace: parent?.namespace ?? null,
          parent_resource_type: parent?.type ?? null,
          parent_resource_id: parent?.id ?? null,
          retired_at: null,
          retired_by_principal_id: null,
          created_at: now,
          updated_at: now,
        }),
      );
    }
    executeSqliteQuerySync(
      db,
      kysely.insertInto("authorization_agent_sponsors").values({
        domain_id: domainId,
        agent_principal_id: agentPrincipalId,
        sponsor_principal_id: principalId,
        created_at: now,
      }),
    );
    executeSqliteQuerySync(
      db,
      kysely.insertInto("authorization_delegations").values({
        domain_id: domainId,
        delegation_id: MAIN_AGENT.assignmentId,
        assignment_id: MAIN_AGENT.assignmentId,
        agent_principal_id: agentPrincipalId,
        sponsor_principal_id: principalId,
        created_by_principal_id: principalId,
        state: "active",
        created_at: now,
        updated_at: now,
        revoked_at: null,
      }),
    );
    executeSqliteQuerySync(
      db,
      kysely.insertInto("authorization_agent_session_bindings").values({
        domain_id: domainId,
        binding_id: MAIN_AGENT.assignmentId,
        runtime_agent_id: MAIN_AGENT.runtimeAgentId,
        session_key: MAIN_AGENT.sessionKey,
        delegation_id: MAIN_AGENT.assignmentId,
        assignment_id: MAIN_AGENT.assignmentId,
        agent_principal_id: agentPrincipalId,
        sponsor_principal_id: principalId,
        created_by_principal_id: principalId,
        state: "active",
        created_at: now,
        updated_at: now,
        revoked_at: null,
      }),
    );
    for (const [resource, permission] of [
      [INITIAL_WORKSPACE, "workspaces.workspace.read"],
      [INITIAL_TAB, "workspaces.tab.read"],
      [INITIAL_TAB, "workspaces.tab.write"],
      [INITIAL_TAB, "workspaces.tab.changeRequest.create"],
    ] as const) {
      executeSqliteQuerySync(
        db,
        kysely.insertInto("authorization_grants").values({
          domain_id: domainId,
          principal_id: agentPrincipalId,
          namespace: resource.namespace,
          resource_type: resource.type,
          resource_id: resource.id,
          permission,
          granted_by_principal_id: principalId,
          created_at: now,
        }),
      );
    }
    return Object.freeze({
      account: Object.freeze({ id: accountId, principalId, loginLabel, createdAt: now }),
      agent: Object.freeze({
        principalId: agentPrincipalId,
        runtimeAgentId: MAIN_AGENT.runtimeAgentId,
        sessionKey: MAIN_AGENT.sessionKey,
        assignmentId: MAIN_AGENT.assignmentId,
      }),
      domainId,
    });
  }, input.database);
}
