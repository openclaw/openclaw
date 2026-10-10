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
    if (
      request.stage === "commit" &&
      isRecord(facts) &&
      isRecord(facts.publication) &&
      facts.publication.kind === "pending-input-settlement-custody" &&
      isRecord(facts.publication.receipt) &&
      facts.publication.receipt.operation === params.operation &&
      facts.publication.receipt.sessionId === params.sessionId &&
      facts.publication.receipt.runId === params.runId
    ) {
      throw new Error(params.message);
    }
    callback(request, grant);
  });
}
