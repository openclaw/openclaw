import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import { jsonPathValue, jsonValid } from "../infra/database-engine/json-values.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { readHiddenGitLabSecretInDatabase } from "../secrets/store/secret-store-hidden-managed-gitlab.kernel.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import { ensurePersonalGitLabPublicationSchema } from "../state/openclaw-state-db-schema-additive.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { readUserGitLabConnectionInDatabase } from "../state/user-gitlab-connections.kernel.js";
import {
  managedGitLabPublicationGeneration,
  publicationPublisher,
  type GitLabPublicationPublisher,
} from "./gitlab-personal-publication-identity.js";
import { gitLabPublicationReceiptSchema } from "./gitlab-personal-publication-row.js";
import {
  personalGitLabRequestDigest,
  type PersonalGitLabPublicationRow,
} from "./gitlab-personal-publication-store.js";

const table = "gitlab_personal_publication_requests";
const query = (db: EngineConnection) => getNodeSqliteKysely<Pick<DB, typeof table>>(db);
export const gitLabSharedPublisherPredicate = (db: EngineConnection) => {
  const receipt =
    /* kysely-allow-raw: Fixed native receipt column, never a caller-selected identifier. */ sql.ref(
      "receipt_json",
    );
  return /* kysely-allow-raw: Engine-neutral CASE guards the engine-owned JSON projection; all values are bound. */ sql<boolean>`CASE WHEN ${jsonValid(db, receipt)} THEN ${jsonPathValue(db, receipt, sql.val("$.publisher.source"))} IN (${"system-configured"}, ${"agent-override"}) ELSE FALSE END`;
};

function checked(row: PersonalGitLabPublicationRow): PersonalGitLabPublicationRow {
  if (row.request_digest !== personalGitLabRequestDigest(row)) {
    throw new Error("Personal GitLab publication receipt is corrupt.");
  }
  let receipt: unknown;
  try {
    receipt = JSON.parse(row.receipt_json);
  } catch {
    throw new Error("Personal GitLab publication accepted checkpoint is invalid.");
  }
  const object = isRecord;
  const parsedPublisher = object(receipt)
    ? gitLabPublicationReceiptSchema.shape.publisher.safeParse(receipt.publisher)
    : null;
  const publisher = parsedPublisher?.success
    ? publicationPublisher(parsedPublisher.data)
    : undefined;
  if (
    !object(receipt) ||
    !object(receipt.target) ||
    !object(receipt.actor) ||
    !object(receipt.sessionIdentity) ||
    !publisher ||
    (publisher.source !== "personal" &&
      row.connection_generation !==
        managedGitLabPublicationGeneration({
          publisher,
          issuer: row.issuer,
          accountId: row.identity_account_id,
          login: row.identity_login,
        })) ||
    receipt.target.issuer !== row.issuer ||
    !Number.isInteger(receipt.target.projectId) ||
    Number(receipt.target.projectId) <= 0 ||
    receipt.actor.accountId !== row.identity_account_id ||
    receipt.actor.login !== row.identity_login ||
    receipt.sessionIdentity.sessionId !== row.session_id ||
    receipt.sessionIdentity.sessionKey !== row.session_key ||
    receipt.sessionIdentity.agentId !== row.agent_id ||
    receipt.sessionIdentity.lifecycleRevision !== row.session_lifecycle_revision ||
    receipt.worktreeId !== row.worktree_id ||
    receipt.repositoryFingerprint !== row.repository_fingerprint ||
    receipt.branch !== row.branch ||
    receipt.createdAtMs !== row.created_at_ms ||
    [receipt.sourceHead, receipt.baseTree, receipt.workspaceHead].some(
      (oid) => typeof oid !== "string" || !/^[a-f0-9]{40}$/u.test(oid),
    ) ||
    typeof receipt.repositoryRoot !== "string" ||
    !receipt.repositoryRoot ||
    typeof receipt.sourceIndexTree !== "string" ||
    !/^[a-f0-9]{40}$/u.test(receipt.sourceIndexTree) ||
    ["headCommit", "lastEffect", "effectState", "outcome"].some((key) => key in receipt)
  ) {
    throw new Error("Personal GitLab publication accepted checkpoint is inconsistent.");
  }
  return row;
}

function receiptPublisher(row: PersonalGitLabPublicationRow): GitLabPublicationPublisher {
  const parsed: unknown = JSON.parse(row.receipt_json);
  if (!isRecord(parsed)) {
    throw new Error("GitLab publication receipt is invalid.");
  }
  return publicationPublisher(
    gitLabPublicationReceiptSchema.shape.publisher.parse(parsed.publisher),
  );
}

function assertConnection(db: EngineConnection, row: PersonalGitLabPublicationRow): void {
  const publisher = receiptPublisher(row);
  if (publisher.source !== "personal") {
    const raw = readHiddenGitLabSecretInDatabase(
      db,
      `gitlab-oauth-${publisher.profileId.slice(4)}`,
      Date.now(),
    );
    let record: unknown;
    try {
      record = raw ? JSON.parse(raw) : undefined;
    } catch {
      throw new Error("Managed GitLab publication identity changed.");
    }
    if (
      !isRecord(record) ||
      !isRecord(record.account) ||
      !isRecord(record.tokens) ||
      record.profileId !== publisher.profileId ||
      record.createdAtMs !== publisher.recordCreatedAtMs ||
      record.issuer !== row.issuer ||
      record.scope !== (publisher.source === "agent-override" ? "agent" : "system") ||
      (publisher.source === "agent-override" && record.agentId !== row.agent_id) ||
      record.account.accountId !== row.identity_account_id ||
      record.account.login !== row.identity_login ||
      record.account.issuer !== row.issuer ||
      !Number.isSafeInteger(record.tokens.expiresAtMs) ||
      Number(record.tokens.expiresAtMs) <= Date.now() ||
      record.pendingInitial !== undefined ||
      record.refreshClaim !== undefined ||
      record.refreshFailure !== undefined
    ) {
      throw new Error("Managed GitLab publication identity changed.");
    }
    return;
  }
  const connection = readUserGitLabConnectionInDatabase(db, row.owner_profile_id, row.issuer);
  if (
    connection?.generation !== row.connection_generation ||
    connection.selection.kind !== "connected" ||
    connection.selection.refresh ||
    connection.selection.refreshFailure ||
    connection.selection.account.accountId !== row.identity_account_id ||
    connection.selection.account.login !== row.identity_login
  ) {
    throw new Error("Personal GitLab publication connection changed.");
  }
}

export function readPersonalGitLabPublicationInDatabase(
  db: EngineConnection,
  owner: string,
  issuer: string,
  selector:
    | { requestId: string }
    | { sessionId: string; idempotencyKey: string }
    | { sessionKey: string; agentId: string },
): PersonalGitLabPublicationRow | undefined {
  if (!tableExists(db, table)) {
    return undefined;
  }
  let selection = query(db)
    .selectFrom(table)
    .selectAll()
    .where("owner_profile_id", "=", owner)
    .where("issuer", "=", issuer);
  selection =
    "requestId" in selector
      ? selection.where("request_id", "=", selector.requestId)
      : "sessionId" in selector
        ? selection
            .where("session_id", "=", selector.sessionId)
            .where("idempotency_key", "=", selector.idempotencyKey)
        : selection
            .where("session_key", "=", selector.sessionKey)
            .where("agent_id", "=", selector.agentId)
            .where("status", "in", ["requested", "publishing", "needs_confirmation"])
            .orderBy("created_at_ms", "desc")
            .orderBy("request_id", "desc")
            .limit(1);
  const row = executeSqliteQueryTakeFirstSync(db, selection);
  return row ? checked(row) : undefined;
}

export function readSharedGitLabPublicationInDatabase(
  db: EngineConnection,
  input: {
    issuer: string;
    sessionId: string;
    sessionKey: string;
    agentId: string;
    lifecycleRevision: string | null;
    selector:
      | { requestId: string }
      | { idempotencyKey: string }
      | { pending: true }
      | { latest: true };
    workspace?: { id: string; repoFingerprint: string; branch: string };
  },
): PersonalGitLabPublicationRow | undefined {
  if (!tableExists(db, table)) {
    return undefined;
  }
  let selection = query(db)
    .selectFrom(table)
    .selectAll()
    .where("issuer", "=", input.issuer)
    .where("session_id", "=", input.sessionId)
    .where("session_key", "=", input.sessionKey)
    .where("agent_id", "=", input.agentId)
    .where(
      "session_lifecycle_revision",
      input.lifecycleRevision === null ? "is" : "=",
      input.lifecycleRevision,
    )
    .where(gitLabSharedPublisherPredicate(db));
  if ("requestId" in input.selector) {
    selection = selection.where("request_id", "=", input.selector.requestId);
  } else if ("idempotencyKey" in input.selector) {
    selection = selection.where("idempotency_key", "=", input.selector.idempotencyKey);
  } else if ("pending" in input.selector) {
    selection = selection.where("status", "in", ["requested", "publishing", "needs_confirmation"]);
  }
  const rows = executeSqliteQuerySync(
    db,
    selection.orderBy("created_at_ms", "desc").orderBy("request_id", "desc"),
  ).rows;
  for (const row of rows) {
    checked(row);
    if (
      ("requestId" in input.selector || "idempotencyKey" in input.selector) &&
      (row.status === "published" || row.status === "failed")
    ) {
      return row;
    }
    const workspace = input.workspace;
    if (!workspace || !tableExists(db, "worktrees")) {
      return undefined;
    }
    const current = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<Pick<DB, "worktrees">>(db)
        .selectFrom("worktrees")
        .select(["id", "owner_kind", "owner_id", "repo_fingerprint", "branch", "removed_at"])
        .where("id", "=", workspace.id),
    );
    if (
      !current ||
      current.owner_kind !== "session" ||
      current.owner_id !== input.sessionKey ||
      current.removed_at !== null ||
      current.repo_fingerprint !== workspace.repoFingerprint ||
      current.branch !== workspace.branch
    ) {
      return undefined;
    }
    if (
      row.worktree_id === workspace.id &&
      row.repository_fingerprint === workspace.repoFingerprint &&
      row.branch === workspace.branch
    ) {
      return row;
    }
  }
  return undefined;
}

export function insertPersonalGitLabPublicationInDatabase(
  database: OpenClawStateDatabase,
  row: PersonalGitLabPublicationRow,
  assertCurrent: () => void,
): PersonalGitLabPublicationRow {
  const { db } = database;
  assertCurrent();
  ensurePersonalGitLabPublicationSchema(db);
  checked(row);
  assertConnection(db, row);
  const unresolved = executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom(table)
      .selectAll()
      .where("issuer", "=", row.issuer)
      .where("session_id", "=", row.session_id)
      .where("session_key", "=", row.session_key)
      .where("agent_id", "=", row.agent_id)
      .where(
        "session_lifecycle_revision",
        row.session_lifecycle_revision === null ? "is" : "=",
        row.session_lifecycle_revision,
      )
      .where("worktree_id", "=", row.worktree_id)
      .where("repository_fingerprint", "=", row.repository_fingerprint)
      .where("branch", "=", row.branch)
      .where("status", "in", ["requested", "publishing", "needs_confirmation"]),
  ).rows;
  for (const pending of unresolved) {
    checked(pending);
    if (pending.request_id !== row.request_id || pending.request_digest !== row.request_digest) {
      throw new Error("GitLab publication workspace has an unresolved request.");
    }
  }
  const inserted = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .insertInto(table)
      .values(row)
      .onConflict((conflict) => conflict.doNothing())
      .returningAll(),
  );
  if (inserted) {
    assertCurrent();
    githubPublicationReceipts.stageRow(db, "gitlab-personal", inserted);
    return inserted;
  }
  const existing = readPersonalGitLabPublicationInDatabase(db, row.owner_profile_id, row.issuer, {
    sessionId: row.session_id,
    idempotencyKey: row.idempotency_key,
  });
  if (!existing || existing.request_digest !== row.request_digest) {
    throw new Error("Personal GitLab publication idempotency key was reused.");
  }
  assertCurrent();
  return existing;
}

export function claimPersonalGitLabPublicationInDatabase(
  database: OpenClawStateDatabase,
  row: PersonalGitLabPublicationRow,
  instanceId: string,
  executionId: string,
  assertCurrent: () => void,
): PersonalGitLabPublicationRow {
  const { db } = database;
  assertCurrent();
  checked(row);
  if (row.status !== "requested" && row.status !== "needs_confirmation") {
    throw new Error("Personal GitLab publication is not awaiting execution.");
  }
  assertConnection(db, row);
  const updated = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .updateTable(table)
      .set({
        status: "publishing",
        gateway_instance_id: instanceId,
        execution_id: executionId,
        updated_at_ms: Date.now(),
      })
      .where("request_id", "=", row.request_id)
      .where("owner_profile_id", "=", row.owner_profile_id)
      .where("issuer", "=", row.issuer)
      .where("request_digest", "=", row.request_digest)
      .where("status", "=", row.status)
      .where("execution_id", row.execution_id === null ? "is" : "=", row.execution_id)
      .returningAll(),
  );
  if (!updated) {
    throw new Error("Personal GitLab publication execution changed.");
  }
  assertCurrent();
  githubPublicationReceipts.stageRow(db, "gitlab-personal", updated);
  return checked(updated);
}

export function writePersonalGitLabPublicationInDatabase(
  database: OpenClawStateDatabase,
  row: PersonalGitLabPublicationRow,
  instanceId: string,
  executionId: string,
  values: Partial<PersonalGitLabPublicationRow>,
): PersonalGitLabPublicationRow {
  const { db } = database;
  const updated = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .updateTable(table)
      .set({ ...values, updated_at_ms: Date.now() })
      .where("request_id", "=", row.request_id)
      .where("owner_profile_id", "=", row.owner_profile_id)
      .where("issuer", "=", row.issuer)
      .where("request_digest", "=", row.request_digest)
      .where("status", "=", "publishing")
      .where("gateway_instance_id", "=", instanceId)
      .where("execution_id", "=", executionId)
      .returningAll(),
  );
  if (!updated) {
    throw new Error("Personal GitLab publication execution is no longer current.");
  }
  githubPublicationReceipts.stageRow(db, "gitlab-personal", updated);
  return checked(updated);
}

export function requirePersonalGitLabPublicationConfirmationInDatabase(
  database: OpenClawStateDatabase,
  instanceId: string,
): PersonalGitLabPublicationRow[] {
  if (!tableExists(database.db, table)) {
    return [];
  }
  const rows = executeSqliteQuerySync(
    database.db,
    query(database.db)
      .updateTable(table)
      .set({ status: "needs_confirmation", updated_at_ms: Date.now() })
      .where("status", "in", ["requested", "publishing"])
      .where((eb) =>
        eb.or([eb("gateway_instance_id", "is", null), eb("gateway_instance_id", "!=", instanceId)]),
      )
      .returningAll(),
  ).rows;
  for (const row of rows) {
    checked(row);
    githubPublicationReceipts.stageRow(database.db, "gitlab-personal", row);
  }
  return rows;
}

export function listUnreportedPersonalGitLabPublicationsInDatabase(db: EngineConnection) {
  if (!tableExists(db, table)) {
    return [];
  }
  return executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom(table)
      .selectAll()
      .where("status", "in", ["published", "failed"])
      .where("reported_at_ms", "is", null)
      .orderBy("updated_at_ms"),
  ).rows.map(checked);
}

export function markPersonalGitLabPublicationReportedInDatabase(
  database: OpenClawStateDatabase,
  requestId: string,
): PersonalGitLabPublicationRow | undefined {
  if (!tableExists(database.db, table)) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    query(database.db)
      .updateTable(table)
      .set({ reported_at_ms: Date.now() })
      .where("request_id", "=", requestId)
      .where("status", "in", ["published", "failed"])
      .returningAll(),
  );
  if (row) {
    checked(row);
    githubPublicationReceipts.stageRow(database.db, "gitlab-personal", row);
  }
  return row;
}
