import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import {
  prepareSessionTranscriptArchivePublishPlans,
  recordSessionTranscriptArchivePublishResults,
} from "./session-accessor.sqlite-archive-store-kernel.js";
import type {
  SqliteSessionReclamationCallbacks,
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";

/** Archive metadata retains the reclamation worker's transaction and commit authority. */
export function reclaimSessionArchivePublicationInTransaction(
  plan: Extract<
    SqliteSessionReclamationPlan,
    { kind: "archive-publish-prepare" | "archive-publish-record" }
  >,
  callbacks: SqliteSessionReclamationCallbacks,
): SqliteSessionReclamationResult {
  return runOpenClawAgentWriteTransaction((database) => {
    callbacks.beforeMutation?.();
    if (plan.kind === "archive-publish-prepare") {
      const value = prepareSessionTranscriptArchivePublishPlans(database, plan);
      if (value.length > 0) {
        callbacks.onCommit?.(database);
      }
      return { kind: plan.kind, value };
    }
    recordSessionTranscriptArchivePublishResults(database, plan.results, plan.nowMs);
    callbacks.onCommit?.(database);
    return { kind: plan.kind, value: true };
  }, plan.databaseOptions);
}
