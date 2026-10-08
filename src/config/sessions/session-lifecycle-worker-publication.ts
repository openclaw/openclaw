import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import type {
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

/** Worker-local reset notifications become eligible only with the owning commit receipt. */
export function publishSessionLifecycleWorkerEffects(
  plan: SqliteSessionReclamationPlan,
  result: SqliteSessionReclamationResult,
) {
  if (plan.kind !== "lifecycle-projection-commit" || result.kind !== plan.kind) {
    return;
  }
  for (const sessionId of result.value.projectionReconcileSessionIds ?? []) {
    startSessionTranscriptIndexReconcile({
      ...plan.databaseOptions,
      preferredSessionId: sessionId,
    });
  }
  for (const sessionKey of result.value.progressCardResetKeys ?? []) {
    emitSessionLifecycleEvent({ agentId: plan.agentId, sessionKey, reason: "progress-card-reset" });
  }
}
