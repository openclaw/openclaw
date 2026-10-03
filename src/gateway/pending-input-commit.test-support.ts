import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";

/** Refuse one fixture's real worker commit without replacing its mutation or settlement. */
export function refusePendingInputCommit(params: {
  operation: "stage" | "complete" | "finish";
  message: string;
  sessionId: string;
  runId: string;
}) {
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  return vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((callback, attachment) =>
      createAdmission((request, grant) => {
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
      }, attachment),
    );
}
