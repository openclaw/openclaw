import { requestSessionEntryCurrentAdmission } from "../config/sessions/session-entry-current-admission.worker.js";
import type {
  SessionEntryCurrentCheck,
  SessionEntryCurrentSource,
} from "../config/sessions/session-entry-current.types.js";
import { runGitHubPublicationMutation } from "../gateway/github-publication-mutation.js";
import type { GitHubPublicationCommit } from "../gateway/github-publication-review-store.types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { deferSqliteWorkerCommitReceipt } from "../infra/sqlite-worker-operation-admission.js";
import type {
  GitHubSessionReceiptGeneration,
  GitHubSessionReceiptIdentities,
} from "./github-publication-read.types.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

/** Capture historical receipts while the session still owns its logical keys. */
export async function preparePersonalGitHubSessionReceiptDeletion(params: {
  agentId: string;
  generations: readonly GitHubSessionReceiptGeneration[];
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
}): Promise<
  (assertCurrent?: () => void, sessionEntryCurrent?: SessionEntryCurrentCheck) => Promise<void>
> {
  params.assertCurrent?.();
  const context = captureOpenClawStateWorkerContext({ env: params.env });
  const generations = params.generations.map((generation) => ({ ...generation }));
  const input = {
    agentId: params.agentId,
    sessionKeys: [...new Set(generations.map((generation) => generation.sessionKey))],
  };
  const { runOpenClawStateWorkerOperation } = await import("./openclaw-state-worker-store.js");
  const receipts = (await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "githubPublication.prepareSessionReceiptDeletion", input }),
    { assertCurrent: params.assertCurrent, existingOnly: true },
  )) ?? { personal: [], repository: [] };
  params.assertCurrent?.();
  return async (assertCurrent, sessionEntryCurrent) => {
    const assertAdmission = () => {
      context.admission.assertCurrent();
      assertCurrent?.();
    };
    await runGitHubPublicationMutation(
      context,
      (scope) =>
        scope.execute({
          type: "githubPublication.deleteSessionReceipts",
          input: {
            ...input,
            generations,
            receipts,
            sessionEntryCurrentSource: sessionEntryCurrent?.source,
          },
        }),
      assertAdmission,
      sessionEntryCurrent,
    );
  };
}

export function readSessionReceiptDeletionIdentitiesInDatabase(
  database: OpenClawStateDatabase,
  params: { agentId: string; sessionKeys: readonly string[] },
): GitHubSessionReceiptIdentities {
  const read = (
    table: "github_personal_publication_requests" | "github_repository_publication_requests",
  ) =>
    params.sessionKeys.length && tableExists(database.db, table)
      ? executeSqliteQuerySync(
          database.db,
          getNodeSqliteKysely<DB>(database.db)
            .selectFrom(table)
            .select(["request_id", "session_id", "session_key", "created_at_ms"])
            .where("agent_id", "=", params.agentId)
            .where("session_key", "in", params.sessionKeys),
        ).rows
      : [];
  return {
    personal: read("github_personal_publication_requests"),
    repository: read("github_repository_publication_requests"),
  };
}

/** Exact historical receipts and late inserts for the removed generation share one SQL edge. */
export function deletePersonalGitHubSessionReceiptsInDatabase(
  database: OpenClawStateDatabase,
  params: {
    agentId: string;
    sessionKeys: readonly string[];
    generations: readonly GitHubSessionReceiptGeneration[];
    receipts: GitHubSessionReceiptIdentities;
    sessionEntryCurrentSource?: SessionEntryCurrentSource;
  },
): GitHubPublicationCommit<void> {
  const tables = [
    "github_personal_publication_requests",
    "github_repository_publication_requests",
  ] as const;
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const result: GitHubPublicationCommit<void> = {
        kind: "github-publication",
        value: undefined,
        reviews: [],
        sessions: [],
      };
      requestSessionEntryCurrentAdmission(
        params.sessionEntryCurrentSource,
        { stage: "transaction", facts: undefined },
        { lookup: "logical" },
      );
      const existing = tables.filter((table) => tableExists(db, table));
      const hasReviews = tableExists(db, "github_publication_review_candidates");
      const query = getNodeSqliteKysely<DB>(db);
      // Archive retains review history. Permanent deletion removes only captured
      // incarnations, never a replacement conversation that reused the key.
      if (hasReviews) {
        for (const generation of params.generations) {
          const deleted = executeSqliteQuerySync(
            db,
            query
              .deleteFrom("github_publication_review_candidates")
              .where("agent_id", "=", params.agentId)
              .where("session_key", "=", generation.sessionKey)
              .where("session_id", "=", generation.sessionId)
              .where(
                "lifecycle_revision",
                generation.lifecycleRevision === null ? "is" : "=",
                generation.lifecycleRevision,
              )
              .returning("review_id"),
          ).rows;
          result.reviews.push(
            ...deleted.map((row) => ({ reviewId: row.review_id, row: undefined })),
          );
        }
      }
      const hasLifecycles = tableExists(db, "github_publication_session_lifecycles");
      const current = readSessionReceiptDeletionIdentitiesInDatabase(database, params);
      for (const table of existing) {
        const historical =
          table === "github_personal_publication_requests"
            ? params.receipts.personal
            : params.receipts.repository;
        const captured = new Map(historical.map((receipt) => [receipt.request_id, receipt]));
        const selected = (
          table === "github_personal_publication_requests" ? current.personal : current.repository
        )
          .filter((receipt) => {
            const previous = captured.get(receipt.request_id);
            if (
              previous &&
              previous.session_id === receipt.session_id &&
              previous.session_key === receipt.session_key &&
              previous.created_at_ms === receipt.created_at_ms
            ) {
              return true;
            }
            const generation = params.generations.find(
              (candidate) =>
                candidate.sessionKey === receipt.session_key &&
                candidate.sessionId === receipt.session_id,
            );
            if (!generation) {
              return false;
            }
            // A missing personal sidecar is unproven, unlike an explicit absent revision.
            const binding =
              table === "github_personal_publication_requests"
                ? hasLifecycles
                  ? executeSqliteQueryTakeFirstSync(
                      db,
                      query
                        .selectFrom("github_publication_session_lifecycles")
                        .select("lifecycle_revision")
                        .where("publication_kind", "=", "personal")
                        .where("request_id", "=", receipt.request_id),
                    )
                  : undefined
                : executeSqliteQueryTakeFirstSync(
                    db,
                    query
                      .selectFrom("github_repository_publication_requests")
                      .select("session_lifecycle_revision as lifecycle_revision")
                      .where("request_id", "=", receipt.request_id),
                  );
            return (
              binding !== undefined && binding.lifecycle_revision === generation.lifecycleRevision
            );
          })
          .map((receipt) => receipt.request_id);
        if (selected.length === 0) {
          continue;
        }
        // Materialize before deleting sidecars: late personal receipts are selected through them.
        if (table === "github_personal_publication_requests" && hasLifecycles) {
          for (const requestId of selected) {
            executeSqliteQuerySync(
              db,
              query
                .deleteFrom("github_publication_session_lifecycles")
                .where("publication_kind", "=", "personal")
                .where("request_id", "=", requestId),
            );
          }
        }
        for (const requestId of selected) {
          executeSqliteQuerySync(db, query.deleteFrom(table).where("request_id", "=", requestId));
        }
      }
      requestSessionEntryCurrentAdmission(
        params.sessionEntryCurrentSource,
        { stage: "commit", facts: result },
        { lookup: "logical" },
      );
      deferSqliteWorkerCommitReceipt(db, result);
      return result;
    },
    { database },
    { operationLabel: "github-personal-publication.session-delete" },
  );
}
