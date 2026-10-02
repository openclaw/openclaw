import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { ensureGitHubPublicationReviewSchema } from "../state/openclaw-state-db-schema-additive.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type {
  WorkerOperationContext,
  WorkerOperations,
} from "../state/worker-operation-registry.js";
import type { PublicationSessionIdentity } from "./github-publication-availability.js";
import { readGitHubPublicationReviewCandidate } from "./github-publication-review-rows.js";
import {
  reviewObservation,
  type GitHubPublicationCommit,
  type GitHubPublicationReviewRead,
  type GitHubPublicationReviewRow,
} from "./github-publication-review-store.types.js";

const table = "github_publication_review_candidates";
const query = (db: DatabaseSync) => getNodeSqliteKysely<Pick<DB, typeof table>>(db);

export function readGitHubPublicationReviewsInDatabase(
  db: DatabaseSync,
  input: GitHubPublicationReviewRead,
): GitHubPublicationReviewRow[] {
  if (!tableExists(db, table)) {
    return [];
  }
  let selection = query(db).selectFrom(table).selectAll();
  switch (input.kind) {
    case "row": {
      const selector = input.selector;
      selection = selection
        .where(
          "reviewId" in selector ? "review_id" : "publication_request_id",
          "=",
          "reviewId" in selector ? selector.reviewId : selector.publicationRequestId,
        )
        .limit(1);
      break;
    }
    case "find":
      selection = selection
        .where("session_id", "=", input.sessionId)
        .where("requester_profile_id", "=", input.profileId)
        .where("idempotency_key", "=", input.idempotencyKey)
        .limit(1);
      break;
    case "session":
      selection = selection
        .where("session_id", "=", input.session.sessionId)
        .where("session_key", "=", input.session.sessionKey)
        .where("agent_id", "=", input.session.agentId)
        .orderBy("created_at_ms", "desc")
        .orderBy("review_id", "desc")
        .limit(20);
      break;
    case "unreported":
      selection = selection
        .where("reported_at_ms", "is", null)
        .where("publication_request_id", "is", null)
        .orderBy("created_at_ms")
        .limit(100);
      break;
  }
  return executeSqliteQuerySync(db, selection).rows;
}

export function publicationCommit<T>(
  value: T,
  rows: GitHubPublicationReviewRow[] = [],
  changed = true,
): GitHubPublicationCommit<T> {
  return {
    kind: "github-publication",
    value,
    reviews: rows.map((row) => ({ reviewId: row.review_id, row: reviewObservation(row) })),
    sessions: changed
      ? rows.map((row) => ({ sessionKey: row.session_key, agentId: row.agent_id }))
      : [],
  };
}

function insert(db: DatabaseSync, row: GitHubPublicationReviewRow) {
  ensureGitHubPublicationReviewSchema(db);
  const existing = readGitHubPublicationReviewsInDatabase(db, {
    kind: "find",
    sessionId: row.session_id,
    profileId: row.requester_profile_id,
    idempotencyKey: row.idempotency_key,
  })[0];
  if (existing) {
    if (
      existing.candidate_json !== row.candidate_json ||
      existing.requested_review_id !== row.requested_review_id ||
      existing.requester_authority_json !== row.requester_authority_json ||
      existing.lifecycle_revision !== row.lifecycle_revision
    ) {
      throw new Error("Publication review idempotency key was reused; start a new review.");
    }
    return publicationCommit(existing);
  }
  if (row.candidate_json) {
    readGitHubPublicationReviewCandidate(row);
  }
  if (row.requested_review_id) {
    const requested = readGitHubPublicationReviewsInDatabase(db, {
      kind: "row",
      selector: { reviewId: row.requested_review_id },
    })[0];
    if (
      !requested ||
      requested.candidate_json ||
      requested.session_id !== row.session_id ||
      requested.session_key !== row.session_key ||
      requested.agent_id !== row.agent_id ||
      requested.lifecycle_revision !== row.lifecycle_revision
    ) {
      throw new Error("The original review request no longer matches this session.");
    }
  }
  executeSqliteQuerySync(db, query(db).insertInto(table).values(row));
  return publicationCommit(row, [row]);
}

/** Receipt and candidate consumption share the caller's admitted transaction. */
export function bindGitHubPublicationReviewInDatabase(
  db: DatabaseSync,
  reference: { reviewId: string; digest: string },
  session: PublicationSessionIdentity,
  requestId: string,
): { row: GitHubPublicationReviewRow; changed: boolean } {
  const current = readGitHubPublicationReviewsInDatabase(db, {
    kind: "row",
    selector: { reviewId: reference.reviewId },
  })[0];
  if (
    !current ||
    current.candidate_digest !== reference.digest ||
    current.stale_reason ||
    !current.candidate_json ||
    current.session_id !== session.sessionId ||
    current.session_key !== session.sessionKey ||
    current.agent_id !== session.agentId ||
    current.lifecycle_revision !== (session.lifecycleRevision ?? null) ||
    (current.publication_request_id && current.publication_request_id !== requestId)
  ) {
    throw new Error("The reviewed candidate was already consumed or changed.");
  }
  readGitHubPublicationReviewCandidate(current);
  // Replays refresh the bound observation without announcing another mutation.
  if (current.publication_request_id === requestId) {
    return { row: current, changed: false };
  }
  const updated = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .updateTable(table)
      .set({ publication_request_id: requestId })
      .where("review_id", "=", current.review_id)
      .where("candidate_digest", "=", reference.digest)
      .where("publication_request_id", "is", null)
      .where("stale_reason", "is", null)
      .returningAll(),
  );
  if (!updated) {
    throw new Error("The reviewed candidate was already consumed or changed.");
  }
  return { row: updated, changed: true };
}

export function transactGitHubPublication<T>(
  context: WorkerOperationContext,
  apply: (db: DatabaseSync) => GitHubPublicationCommit<T>,
) {
  const database = context.open();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const result = apply(db);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: result });
      deferSqliteWorkerCommitReceipt(db, result);
      return result;
    },
    { ...context.stateOptions(), database },
  );
}

export const publicationReviewOperations = {
  "publicationReview.insert": (row: GitHubPublicationReviewRow, context: WorkerOperationContext) =>
    transactGitHubPublication(context, (db) => insert(db, row)),
  "publicationReview.reported": (
    input: { reviewId: string; now: number },
    context: WorkerOperationContext,
  ) =>
    transactGitHubPublication(context, (db) => {
      if (tableExists(db, table)) {
        executeSqliteQuerySync(
          db,
          query(db)
            .updateTable(table)
            .set({ reported_at_ms: input.now })
            .where("review_id", "=", input.reviewId)
            .where("reported_at_ms", "is", null),
        );
      }
      return publicationCommit(undefined);
    }),
  "publicationReview.retire": (
    input: PublicationSessionIdentity & { reviewId: string; now: number },
    context: WorkerOperationContext,
  ) =>
    transactGitHubPublication(context, (db) => {
      const row = tableExists(db, table)
        ? executeSqliteQueryTakeFirstSync(
            db,
            query(db)
              .updateTable(table)
              .set({
                reported_at_ms: input.now,
                stale_reason:
                  "This conversation generation ended. Its review notification was not delivered to the replacement conversation.",
              })
              .where("review_id", "=", input.reviewId)
              .where("session_id", "=", input.sessionId)
              .where("session_key", "=", input.sessionKey)
              .where("agent_id", "=", input.agentId)
              .where(
                "lifecycle_revision",
                input.lifecycleRevision == null ? "is" : "=",
                input.lifecycleRevision ?? null,
              )
              .where("publication_request_id", "is", null)
              .where("reported_at_ms", "is", null)
              .returningAll(),
          )
        : undefined;
      return publicationCommit(undefined, row ? [row] : []);
    }),
  "publicationReview.stale": (
    input: { reviewId: string; digest: string | null; reason: string },
    context: WorkerOperationContext,
  ) =>
    transactGitHubPublication(context, (db) => {
      const row = tableExists(db, table)
        ? executeSqliteQueryTakeFirstSync(
            db,
            query(db)
              .updateTable(table)
              .set({ stale_reason: input.reason })
              .where("review_id", "=", input.reviewId)
              .where("candidate_digest", input.digest === null ? "is" : "=", input.digest)
              .where("stale_reason", "is", null)
              .returningAll(),
          )
        : undefined;
      return publicationCommit(undefined, row ? [row] : []);
    }),
};
export type PublicationReviewWorkerOperations = WorkerOperations<
  typeof publicationReviewOperations
>;
