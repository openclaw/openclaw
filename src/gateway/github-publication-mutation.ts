import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assertSessionEntryCurrentAdmission } from "../config/sessions/session-entry-current-admission.js";
import type { SessionEntryCurrentCheck } from "../config/sessions/session-entry-current.types.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type { DomainScope } from "../state/openclaw-state-worker-store.types.js";
import { stageGitHubPublicationReviewChanges } from "./github-publication-review-publication.js";
import type { GitHubPublicationCommit } from "./github-publication-review-store.types.js";

function isCommit(value: unknown): value is GitHubPublicationCommit<unknown> {
  return (
    isRecord(value) &&
    value.kind === "github-publication" &&
    Array.isArray(value.reviews) &&
    value.reviews.every((change) => {
      if (!isRecord(change) || typeof change.reviewId !== "string") {
        return false;
      }
      const row = change.row;
      return (
        row === undefined ||
        (isRecord(row) &&
          row.review_id === change.reviewId &&
          ["candidate_digest", "stale_reason", "publication_request_id"].every(
            (key) => row[key] === null || typeof row[key] === "string",
          ))
      );
    }) &&
    Array.isArray(value.sessions) &&
    value.sessions.every(
      (session) =>
        isRecord(session) &&
        typeof session.sessionKey === "string" &&
        typeof session.agentId === "string",
    )
  );
}

/** Commit settlement, rather than reply delivery, owns row invalidation and notifications. */
export async function runGitHubPublicationMutation<T>(
  context: OpenClawStateWorkerContext,
  execute: (scope: DomainScope) => Promise<GitHubPublicationCommit<T>>,
  assertCurrent: () => void,
  sessionEntryCurrent?: SessionEntryCurrentCheck,
): Promise<T> {
  let admission: SqliteWorkerOperationAdmission | undefined;
  let prepared: GitHubPublicationCommit<T> | undefined;
  let publication: ReturnType<typeof stageGitHubPublicationReviewChanges> | undefined;
  let settled: Promise<void> | undefined;
  let granted = false;
  const check = () => {
    context.admission.assertCurrent();
    assertCurrent();
  };
  try {
    const result = await runOpenClawStateWorkerOperation(context, execute, {
      assertCurrent: check,
      createAdmission(operation) {
        let stage: "transaction" | "commit" | "complete" = "transaction";
        admission = createSqliteWorkerOperationAdmission((request, grant) => {
          check();
          const current = assertSessionEntryCurrentAdmission(request, sessionEntryCurrent);
          if (
            stage === "transaction" &&
            current.stage === "transaction" &&
            current.facts === undefined
          ) {
            stage = "commit";
            grant();
            return;
          }
          if (stage !== "commit" || current.stage !== "commit" || !isCommit(current.facts)) {
            throw new Error("Publication mutation omitted its admitted commit facts");
          }
          stage = "complete";
          // SAFETY: The selected command binds T to its native receipt; transport validation checks the envelope.
          prepared = current.facts as GitHubPublicationCommit<T>;
          publication = stageGitHubPublicationReviewChanges(context.admission, prepared.reviews);
          granted = grant();
        });
        const acceptedAdmission = admission;
        settled = operation.settled.then((settlement) => {
          let committed = false;
          let known = false;
          try {
            const receipt = acceptedAdmission.committed;
            if (receipt) {
              if (!prepared || !isDeepStrictEqual(receipt.facts, prepared)) {
                throw new Error("Publication commit facts changed during native settlement");
              }
              committed = true;
            }
            known = !granted || committed || settlement.kind === "completed";
          } finally {
            publication?.settle(committed, known);
          }
          if (committed && prepared) {
            try {
              context.admission.assertCurrent();
            } catch {
              return;
            }
            for (const session of prepared.sessions) {
              emitSessionLifecycleEvent({ ...session, reason: "github-publication" });
            }
          }
        });
        void settled.catch(() => undefined);
        return { admission, nativeLocations: [context.admission.databasePath] };
      },
    });
    await settled;
    return result.value;
  } catch (error) {
    await settled;
    if (
      prepared &&
      admission?.committed &&
      isDeepStrictEqual(admission.committed.facts, prepared)
    ) {
      return prepared.value;
    }
    throw error;
  } finally {
    await settled;
  }
}
