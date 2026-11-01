import { isRecord } from "@openclaw/normalization-core/record-coerce";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";

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
