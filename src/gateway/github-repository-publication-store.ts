import { randomUUID } from "node:crypto";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type {
  RepositoryGitHubPublicationRow,
  RepositoryGitHubPublicationReceiptTarget,
} from "../state/github-publication-read.types.js";
import {
  decodeGitHubPublicationRequester,
  matchesGitHubPublicationRequester,
} from "../state/github-publication-requester.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import { ensureRepositoryGitHubPublicationSchema } from "../state/openclaw-state-db-schema-additive.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { deferSharedGitHubPublicationChanged } from "./github-publication-events.js";
import { createGitHubPublicationExecutionEffects } from "./github-publication-execution-effects.js";
import {
  readSharedGitHubPublicationWorkspace,
  type SharedGitHubPublicationSession,
  type SharedGitHubPublicationSelector,
} from "./github-publication-shared-read.js";
import { assertReadableSharedGitHubPublication } from "./github-publication-store.js";
import {
  checkRepositoryGitHubPublication as checked,
  listRepositoryGitHubPublicationsInDatabase,
  repositoryGitHubPublicationDigest,
  type RepositoryGitHubPublicationPendingQuery,
  type RepositoryGitHubPublicationStatusRow,
} from "./github-repository-publication.kernel.js";

export { repositoryGitHubPublicationDigest } from "./github-repository-publication.kernel.js";
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
  deferSharedGitHubPublicationChanged(db, row);
  return row;
}

/** Filter the mixed table before decoding; a private request ID never grants shared access. */
export function readSharedRepositoryGitHubPublication(
  session: SharedGitHubPublicationSession,
  selector: SharedGitHubPublicationSelector,
  entry: SessionEntry,
): RepositoryGitHubPublicationRow | undefined {
  return withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(({ db }) =>
    runSqliteDeferredTransactionSync(db, () => {
      if (!tableExists(db, table)) {
        return undefined;
      }
      let selection = query(db)
        .selectFrom(table)
        .selectAll()
        .where("owner_profile_id", "is", null)
        .where("session_key", "=", session.sessionKey)
        .where("agent_id", "=", session.agentId);
      if ("requestId" in selector) {
        selection = selection.where("request_id", "=", selector.requestId);
        const row = executeSqliteQueryTakeFirstSync(db, selection);
        if (!row) {
          return undefined;
        }
        checked(row);
        assertReadableSharedGitHubPublication(row);
        if (terminalRepositoryGitHubPublication(row)) {
          return row;
        }
      } else {
        if (selector.idempotencyKey !== undefined) {
          selection = selection.where("idempotency_key", "=", selector.idempotencyKey);
        }
        // No shared receipt means there is no workspace evidence to qualify. Personal-only
        // recovery must not depend on an unrelated shared workspace being available.
        if (!executeSqliteQueryTakeFirstSync(db, selection.limit(1))) {
          return undefined;
        }
      }
      const workspace = readSharedGitHubPublicationWorkspace(db, session, entry);
      if (workspace?.kind !== "repository") {
        return undefined;
      }
      const revision = entry.lifecycleRevision ?? null;
      const ordered = selection
        .orderBy("created_at_ms", "desc")
        .orderBy("request_id", "desc")
        .limit(64);
      let cursor: RepositoryGitHubPublicationRow | undefined;
      for (;;) {
        const after = cursor;
        const page = after
          ? ordered.where((eb) =>
              eb.or([
                eb("created_at_ms", "<", after.created_at_ms),
                eb.and([
                  eb("created_at_ms", "=", after.created_at_ms),
                  eb("request_id", "<", after.request_id),
                ]),
              ]),
            )
          : ordered;
        const rows = executeSqliteQuerySync(db, page).rows;
        for (const row of rows) {
          // Validate before scope filtering: a corrupted binding is not evidence of absence.
          checked(row);
          assertReadableSharedGitHubPublication(row);
          if (
            row.session_id === session.sessionId &&
            row.session_lifecycle_revision === revision &&
            row.workspace_id === workspace.workspaceId &&
            row.branch === workspace.branch
          ) {
            return row;
          }
        }
        if (rows.length < 64) {
          return undefined;
        }
        cursor = rows[rows.length - 1]!;
      }
    }),
  );
}

export function listRepositoryGitHubPublications(
  filter: Parameters<typeof listRepositoryGitHubPublicationsInDatabase>[1] = {},
): RepositoryGitHubPublicationRow[] {
  return listRepositoryGitHubPublicationsInDatabase(openOpenClawStateDatabase().db, filter);
}

export async function readPendingRepositoryGitHubPublication(
  input: RepositoryGitHubPublicationPendingQuery,
): Promise<RepositoryGitHubPublicationStatusRow | undefined> {
  const context = captureOpenClawStateWorkerContext();
  const { executeOpenClawStateWorker } = await import("../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "githubRepository.personalPending",
    input,
  });
}

/** A pushed branch outlives its publisher and the request's PR outcome. */
export function readRepositoryGitHubPublicationBranch(input: {
  workspaceId: string;
  branch: string;
  pushRepository: string;
}) {
  const rows = listRepositoryGitHubPublications({ workspaceId: input.workspaceId }).filter(
    (row) => row.branch === input.branch && row.push_repository === input.pushRepository,
  );
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

export function readRepositoryGitHubPublication(
  requestId: string,
): RepositoryGitHubPublicationRow | undefined {
  return readRepositoryGitHubPublicationInDatabase(openOpenClawStateDatabase().db, requestId);
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

export function requireRepositoryGitHubPublication(
  requestId: string,
): RepositoryGitHubPublicationRow {
  const row = readRepositoryGitHubPublication(requestId);
  if (!row) {
    throw new Error("GitHub publication request no longer exists.");
  }
  return row;
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

export function insertRepositoryGitHubPublication(
  row: RepositoryGitHubPublicationRow,
  assertCurrent: () => void,
) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
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
          .where(
            "owner_profile_id",
            row.owner_profile_id === null ? "is" : "=",
            row.owner_profile_id,
          ),
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
        deferSharedGitHubPublicationChanged(db, stored);
      }
      return stored;
    },
    undefined,
    { operationLabel: "github-repository-publication.request" },
  );
}

export function bindRepositoryGitHubPublicationCheckpoint(
  row: RepositoryGitHubPublicationRow,
  checkpoint: Pick<RepositoryGitHubPublicationRow, (typeof checkpointColumns)[number]>,
  assertCurrent: () => void,
) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent();
      const current = readRepositoryGitHubPublication(row.request_id);
      if (
        !current ||
        current.request_digest !== row.request_digest ||
        current.status !== "requested"
      ) {
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
    },
    undefined,
    { operationLabel: "github-repository-publication.checkpoint" },
  );
}

export function failRepositoryGitHubPublicationPreparation(
  row: RepositoryGitHubPublicationRow,
  nextAction: string,
  assertCurrent: () => void,
): RepositoryGitHubPublicationRow {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
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
    },
    undefined,
    { operationLabel: "github-repository-publication.unavailable" },
  );
}

export function claimRepositoryGitHubPublication(
  row: RepositoryGitHubPublicationRow,
  instanceId: string,
  authority: { assertCustody: () => void; assertCurrent: () => void },
) {
  const executionId = randomUUID();
  const claimed = runOpenClawStateWriteTransaction(
    ({ db }) => {
      authority.assertCustody();
      const current = readRepositoryGitHubPublication(row.request_id);
      if (
        !current ||
        current.request_digest !== row.request_digest ||
        terminalRepositoryGitHubPublication(current)
      ) {
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
    },
    undefined,
    { operationLabel: "github-repository-publication.claim" },
  );
  const ownsExecution = () => {
    const current = readRepositoryGitHubPublication(row.request_id);
    return (
      current?.status === "publishing" &&
      current.gateway_instance_id === instanceId &&
      current.execution_id === executionId &&
      current.request_digest === row.request_digest
    );
  };
  const write = (values: Partial<RepositoryGitHubPublicationRow>, requireAction: boolean) =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        // The execution CAS retains result custody after workspace admission ends.
        if (requireAction) {
          authority.assertCustody();
          authority.assertCurrent();
          if (!row.checkpoint_ref || !row.checkpoint_digest || !row.workspace_tree) {
            throw new Error("GitHub publication requires its accepted checkpoint.");
          }
        }
        const current = readRepositoryGitHubPublication(row.request_id);
        if (!current || current.request_digest !== row.request_digest) {
          throw new Error("GitHub publication receipt changed.");
        }
        // A resumed ref observation cannot erase an earlier PR dispatch or receipt.
        const retainPullRequest =
          values.last_effect === "push" && current.last_effect === "pull_request";
        const updated = executeSqliteQueryTakeFirstSync(
          db,
          query(db)
            .updateTable(table)
            .set({
              ...values,
              ...(retainPullRequest
                ? { last_effect: current.last_effect, effect_state: current.effect_state }
                : {}),
              updated_at_ms: Date.now(),
            })
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
      },
      undefined,
      { operationLabel: "github-repository-publication.record" },
    );
  const effects = createGitHubPublicationExecutionEffects({
    write,
    interruptedStatus: row.owner_profile_id === null ? "requested" : "needs_confirmation",
  });
  return {
    row: claimed,
    ownsExecution,
    ...effects,
    recordEffect(...[effect, observed]: Parameters<typeof effects.recordEffect>): void {
      if (effect === "push" && observed?.headCommit) {
        write(
          {
            last_effect: "push",
            effect_state: "observed",
            head_commit: observed.headCommit,
            pushed_head_commit: observed.headCommit,
          },
          false,
        );
      } else {
        effects.recordEffect(effect, observed);
      }
    },
  };
}

export function markRepositoryGitHubPublicationReported(requestId: string): void {
  const database = openOpenClawStateDatabase().db;
  if (!tableExists(database, table)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        query(db)
          .updateTable(table)
          .set({ reported_at_ms: Date.now() })
          .where("request_id", "=", requestId)
          .where("status", "in", ["published", "failed"]),
      );
    },
    undefined,
    { operationLabel: "github-repository-publication.report" },
  );
}

export function failStaleRepositoryGitHubPublication(
  row: RepositoryGitHubPublicationRow,
  sessionIsCurrent: () => boolean,
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const current = readRepositoryGitHubPublication(row.request_id);
      if (
        !current ||
        terminalRepositoryGitHubPublication(current) ||
        current.request_digest !== row.request_digest ||
        sessionIsCurrent()
      ) {
        return;
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
        changed(db, updated);
      }
    },
    undefined,
    { operationLabel: "github-repository-publication.retire" },
  );
}

export function deferRepositoryGitHubPublicationClaims(requestIds: readonly string[]): void {
  if (requestIds.length === 0) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
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
    },
    undefined,
    { operationLabel: "github-repository-publication.defer" },
  );
}

export function terminalRepositoryGitHubPublication(
  row: Pick<RepositoryGitHubPublicationRow, "status">,
): boolean {
  return row.status === "published" || row.status === "failed";
}

export type RepositoryGitHubPublicationExecution = ReturnType<
  typeof claimRepositoryGitHubPublication
>;
