import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  preparePendingInputStore,
  type PendingInputScope,
} from "../config/sessions/session-pending-input-store.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { buildRunUserTurnIdempotencyKey } from "../sessions/user-turn-transcript.metadata.js";

/** Refuse one fixture's real worker commit without replacing its mutation or settlement. */
export function refusePendingInputCommit(params: {
  operation: "stage" | "complete" | "finish";
  message: string;
  sessionId: string;
  runId: string;
}) {
  return probe.admission(workerAdmission, (request, grant, callback) => {
    const facts = request.facts;
    const publication =
      isRecord(facts) && isRecord(facts.publication)
        ? facts.publication.kind === "session-actor-admission"
          ? facts.publication.publication
          : facts.publication
        : undefined;
    if (
      request.stage === "commit" &&
      isRecord(publication) &&
      publication.kind === "pending-input-settlement-custody" &&
      isRecord(publication.receipt) &&
      publication.receipt.operation === params.operation &&
      publication.receipt.sessionId === params.sessionId &&
      publication.receipt.runId === params.runId
    ) {
      throw new Error(params.message);
    }
    callback(request, grant);
  });
}

/** Read the real worker-owned receipt and release its database lifetime. */
export async function readUserTurnCompletionForTest(scope: PendingInputScope, runId: string) {
  const store = await preparePendingInputStore(scope, () => {});
  try {
    const snapshot = await store.read({
      kind: "stage",
      sessionKey: scope.sessionKey,
      sessionId: scope.sessionId,
      idempotencyKey: buildRunUserTurnIdempotencyKey(runId),
      trackCompletion: true,
    });
    if (snapshot.kind !== "stage") {
      throw new Error("Expected a staged user-turn completion snapshot");
    }
    return snapshot.previous;
  } finally {
    await store.release();
  }
}
