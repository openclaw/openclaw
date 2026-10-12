import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../infra/kysely-sync.js";
import type {
  RepositoryGitHubPublicationRow,
  RepositoryGitHubPublicationReceiptTarget,
} from "../state/github-publication-read.types.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import {
  decodeGitHubPublicationRequester,
  matchesGitHubPublicationRequester,
} from "../state/github-publication-requester.js";
import { ensureRepositoryGitHubPublicationSchema } from "../state/openclaw-state-db-schema-additive.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { deferSharedGitHubPublicationChanged } from "./github-publication-events.js";
import { assertReadableSharedGitHubPublication } from "./github-publication-receipt.js";
import { listRepositoryGitHubPublicationsInDatabase } from "./github-repository-publication-read.worker.js";
import { terminalRepositoryGitHubPublication } from "./github-repository-publication-store.js";
import {
  checkRepositoryGitHubPublication as checked,
  repositoryGitHubPublicationDigest,
} from "./github-repository-publication.kernel.js";

const checkpointColumns = [
  "checkpoint_ref",
  "checkpoint_digest",
  "source_head_commit",
  "source_index_tree",
  "workspace_tree",
] satisfies (keyof RepositoryGitHubPublicationRow)[];
const table = "github_repository_publication_requests";
const query = (db: Parameters<typeof getNodeSqliteKysely>[0]) =>
  getNodeSqliteKysely<Pick<DB, typeof table>>(db);
function changed(
  db: Parameters<typeof getNodeSqliteKysely>[0],
  row: RepositoryGitHubPublicationRow,
) {
  checked(row);
  githubPublicationReceipts.stageRow(db, "repository", row);
  deferSharedGitHubPublicationChanged(db, row);
  return row;
}

export function readRepositoryGitHubPublicationBranchInDatabase(
  db: OpenClawStateDatabase["db"],
  input: {
    workspaceId: string;
    branch: string;
    pushRepository: string;
  },
) {
  const rows = listRepositoryGitHubPublicationsInDatabase(db, {
    workspaceId: input.workspaceId,
  }).filter((row) => row.branch === input.branch && row.push_repository === input.pushRepository);
  const pushed = rows.filter((row) => row.pushed_head_commit !== null);
  // Retried ancestors may have newer timestamps; follow recorded parent links instead.
  const ancestors = new Set(pushed.map((row) => row.previous_head_commit));
  return {
    head: pushed.findLast((row) => !ancestors.has(row.pushed_head_commit)),
    unsettled: rows.some(
      (row) => !terminalRepositoryGitHubPublication(row) && row.effect_state === "dispatched",
    ),
  };
}

export function readRepositoryGitHubPublicationInDatabase(
  db: Parameters<typeof getNodeSqliteKysely>[0],
  requestId: string,
): RepositoryGitHubPublicationRow | undefined {
  if (!tableExists(db, table)) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query(db).selectFrom(table).selectAll().where("request_id", "=", requestId),
  );
  return row ? checked(row) : undefined;
}

export function readKnownRepositoryGitHubPublicationPullRequestUrlsInDatabase(
  db: Parameters<typeof getNodeSqliteKysely>[0],
  row: RepositoryGitHubPublicationReceiptTarget,
): string[] {
  const known = new Set(row.pull_request_url ? [row.pull_request_url] : []);
  for (const receipt of iterateSqliteQuerySync(
    db,
    query(db)
      .selectFrom(table)
      .selectAll()
      .where("workspace_id", "=", row.workspace_id)
      .where("owner_profile_id", "is", null)
      .where("push_repository", "=", row.push_repository)
      .where("repository", "=", row.repository)
      .where("branch", "=", row.branch)
      .where("base_branch", "=", row.base_branch)
      .where("identity_account_id", "=", row.identity_account_id)
      .where("status", "=", "published"),
  )) {
    assertReadableSharedGitHubPublication(checked(receipt));
    if (receipt.pull_request_url) {
      known.add(receipt.pull_request_url);
    }
  }
  return [...known];
}

export function insertRepositoryGitHubPublicationInDatabase(
  database: OpenClawStateDatabase,
  row: RepositoryGitHubPublicationRow,
  assertCurrent: () => void,
) {
  const { db } = database;
  assertCurrent();
  ensureRepositoryGitHubPublicationSchema(db);
  checked(row);
  const inserted = executeSqliteQuerySync(
    db,
    query(db)
      .insertInto(table)
      .values(row)
      .onConflict((conflict) => conflict.doNothing()),
  );
  const stored = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom(table)
      .selectAll()
      .where("session_id", "=", row.session_id)
      .where("idempotency_key", "=", row.idempotency_key)
      .where("owner_profile_id", row.owner_profile_id === null ? "is" : "=", row.owner_profile_id),
  );
  if (
    !stored ||
    (
      [
        "session_key",
        "session_lifecycle_revision",
        "agent_id",
        "workspace_id",
        "owner_profile_id",
        "connection_generation",
        "identity_source",
        "identity_profile_id",
        "identity_account_id",
        "identity_login",
        "title",
        "body",
        "claim_id",
        "run_id",
        "placement_generation",
        "environment_id",
        "owner_epoch",
      ] satisfies (keyof RepositoryGitHubPublicationRow)[]
    ).some((key) => stored[key] !== row[key])
  ) {
    throw new Error("GitHub publication idempotency key was reused.");
  }
  if (stored.requester_authority_json !== row.requester_authority_json) {
    const original = decodeGitHubPublicationRequester(stored.requester_authority_json);
    const current = decodeGitHubPublicationRequester(row.requester_authority_json);
    if (!original || !current || !matchesGitHubPublicationRequester(original, current)) {
      throw new Error("GitHub publication idempotency key was reused.");
    }
  }
  checked(stored);
  assertCurrent();
  if (inserted.numAffectedRows === 1n) {
    githubPublicationReceipts.stageRow(db, "repository", stored);
    deferSharedGitHubPublicationChanged(db, stored);
  }
  return stored;
}

export function bindRepositoryGitHubPublicationCheckpointInDatabase(
  database: OpenClawStateDatabase,
  row: RepositoryGitHubPublicationRow,
  checkpoint: Pick<RepositoryGitHubPublicationRow, (typeof checkpointColumns)[number]>,
  assertCurrent: () => void,
) {
  const { db } = database;
  assertCurrent();
  const current = readRepositoryGitHubPublicationInDatabase(db, row.request_id);
  if (!current || current.request_digest !== row.request_digest || current.status !== "requested") {
    throw new Error("GitHub publication checkpoint owner changed.");
  }
  if (current.checkpoint_ref !== null) {
    if (checkpointColumns.some((key) => current[key] !== checkpoint[key])) {
      throw new Error("GitHub publication accepted checkpoint changed.");
    }
    return current;
  }
  const bound = { ...current, ...checkpoint, updated_at_ms: Date.now() };
  bound.request_digest = repositoryGitHubPublicationDigest(bound);
  const updated = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .updateTable(table)
      .set(bound)
      .where("request_id", "=", row.request_id)
      .where("checkpoint_ref", "is", null)
      .where("request_digest", "=", current.request_digest)
      .returningAll(),
  );
  if (!updated) {
    throw new Error("GitHub publication checkpoint ownership changed.");
  }
  assertCurrent();
  return changed(db, updated);
}

export function failRepositoryGitHubPublicationPreparationInDatabase(
  database: OpenClawStateDatabase,
  row: RepositoryGitHubPublicationRow,
  nextAction: string,
  assertCurrent: () => void,
): RepositoryGitHubPublicationRow {
  const { db } = database;
  assertCurrent();
  const updated = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .updateTable(table)
      .set({
        status: "failed",
        error_code: "unavailable",
        next_action: nextAction,
        updated_at_ms: Date.now(),
      })
      .where("request_id", "=", row.request_id)
      .where("request_digest", "=", row.request_digest)
      .where("status", "=", "requested")
      .where("checkpoint_ref", "is", null)
      .where("execution_id", "is", null)
      .returningAll(),
  );
  if (!updated) {
    throw new Error("GitHub publication preparation owner changed.");
  }
  assertCurrent();
  return changed(db, updated);
}

export function writeRepositoryGitHubPublicationInDatabase(
  database: OpenClawStateDatabase,
  row: RepositoryGitHubPublicationRow,
  instanceId: string,
  executionId: string,
  values: Partial<RepositoryGitHubPublicationRow>,
  requireAction: boolean,
  authority: { assertCustody: () => void; assertCurrent: () => void },
) {
  const { db } = database;
  // The execution CAS retains result custody after workspace admission ends.
  if (requireAction) {
    authority.assertCustody();
    authority.assertCurrent();
    if (!row.checkpoint_ref || !row.checkpoint_digest || !row.workspace_tree) {
      throw new Error("GitHub publication requires its accepted checkpoint.");
    }
  }
  const updated = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .updateTable(table)
      .set((eb) => ({
        ...(values.last_effect === "push" && values.head_commit
          ? {
              last_effect: "push",
              effect_state: "observed",
              head_commit: values.head_commit,
              pushed_head_commit: values.head_commit,
            }
          : values),
        // A resumed ref observation cannot erase an earlier PR dispatch or receipt.
        ...(values.last_effect === "push"
          ? {
              last_effect: eb
                .case()
                .when("last_effect", "=", "pull_request")
                .then(eb.ref("last_effect"))
                .else(values.last_effect)
                .end(),
              effect_state: eb
                .case()
                .when("last_effect", "=", "pull_request")
                .then(eb.ref("effect_state"))
                .else(values.head_commit ? "observed" : (values.effect_state ?? null))
                .end(),
            }
          : {}),
        updated_at_ms: Date.now(),
      }))
      .where("request_id", "=", row.request_id)
      .where("request_digest", "=", row.request_digest)
      .where("status", "=", "publishing")
      .where("gateway_instance_id", "=", instanceId)
      .where("execution_id", "=", executionId)
      .returningAll(),
  );
  if (!updated) {
    throw new Error("GitHub publication execution is no longer current.");
  }
  if (requireAction) {
    authority.assertCustody();
    authority.assertCurrent();
  }
  return changed(db, updated);
}

export function claimRepositoryGitHubPublicationInDatabase(
  database: OpenClawStateDatabase,
  row: RepositoryGitHubPublicationRow,
  instanceId: string,
  executionId: string,
  authority: { assertCustody: () => void; assertCurrent: () => void },
) {
  const { db } = database;
  authority.assertCustody();
  if (terminalRepositoryGitHubPublication(row)) {
    throw new Error("GitHub publication receipt changed.");
  }
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
      .where("request_digest", "=", row.request_digest)
      .where("status", "=", row.status)
      .where("execution_id", row.execution_id === null ? "is" : "=", row.execution_id)
      .returningAll(),
  );
  if (!updated) {
    throw new Error("GitHub publication execution changed.");
  }
  authority.assertCustody();
  return changed(db, updated);
}

export function markRepositoryGitHubPublicationReportedInDatabase(
  database: OpenClawStateDatabase,
  requestId: string,
): RepositoryGitHubPublicationRow | undefined {
  if (!tableExists(database.db, table)) {
    return undefined;
  }
  const { db } = database;
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .updateTable(table)
      .set({ reported_at_ms: Date.now() })
      .where("request_id", "=", requestId)
      .where("status", "in", ["published", "failed"])
      .returningAll(),
  );
  if (row) {
    githubPublicationReceipts.stageRow(db, "repository", row);
  }
  return row;
}

export function failStaleRepositoryGitHubPublicationInDatabase(
  database: OpenClawStateDatabase,
  row: RepositoryGitHubPublicationRow,
  sessionIsCurrent: () => boolean,
): RepositoryGitHubPublicationRow | undefined {
  const { db } = database;
  const current = readRepositoryGitHubPublicationInDatabase(db, row.request_id);
  if (
    !current ||
    terminalRepositoryGitHubPublication(current) ||
    current.request_digest !== row.request_digest ||
    sessionIsCurrent()
  ) {
    return undefined;
  }
  // Retention preserves the original effects, not authority to publish after
  // archive/reset. Clearing the execution also fences awaited response writers.
  const updated = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .updateTable(table)
      .set({
        status: "failed",
        error_code: "session_changed",
        next_action:
          "Review any recorded GitHub effects, then request publication from a current session.",
        execution_id: null,
        gateway_instance_id: null,
        updated_at_ms: Date.now(),
      })
      .where("request_id", "=", row.request_id)
      .where("request_digest", "=", row.request_digest)
      .returningAll(),
  );
  if (updated) {
    return changed(db, updated);
  }
  return undefined;
}

export function deferRepositoryGitHubPublicationClaimsInDatabase(
  database: OpenClawStateDatabase,
  requestIds: readonly string[],
): RepositoryGitHubPublicationRow[] {
  if (requestIds.length === 0) {
    return [];
  }
  const { db } = database;
  const updated = executeSqliteQuerySync(
    db,
    query(db)
      .updateTable(table)
      .set({
        claim_id: null,
        run_id: null,
        environment_id: null,
        owner_epoch: null,
        placement_generation: null,
        updated_at_ms: Date.now(),
      })
      .where("request_id", "in", requestIds)
      .where("owner_profile_id", "is", null)
      .where("status", "in", ["requested", "publishing"])
      .returningAll(),
  ).rows;
  for (const row of updated) {
    changed(db, row);
  }
  return updated;
}
