import type { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { readOpenClawAgentDatabaseWorkerLeaseReceipt } from "../../state/openclaw-agent-db-lifecycle.js";
import type { SqliteReclamationWorkerMessage } from "./session-accessor.sqlite-reclamation-worker.js";

/** Observe actual native admission and reclamation receipts without replacing either owner. */
export function observeReclamationLeaseReceipts(database: { agentId: string; path: string }) {
  let admittedLeaseId = readOpenClawAgentDatabaseWorkerLeaseReceipt(database.path).leaseId;
  let reclamationLeaseId: string | undefined;
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
    (admit, attachment) =>
      createAdmission((request, grant) => {
        admit(request, grant);
        const facts = request.facts;
        if (
          request.stage === "prepare" &&
          isRecord(facts) &&
          facts.kind === "shared-owner" &&
          isRecord(facts.lease) &&
          facts.lease.path === database.path &&
          facts.lease.agentId === database.agentId &&
          typeof facts.lease.leaseId === "string"
        ) {
          admittedLeaseId = facts.lease.leaseId;
        }
      }, attachment),
  );
  return {
    onSpawn: (worker: Worker) => {
      worker.on("message", (message: SqliteReclamationWorkerMessage) => {
        if (message.type === "lease" && message.receipt.path === database.path) {
          reclamationLeaseId = message.receipt.leaseId;
        }
      });
    },
    read: () => ({ admittedLeaseId, reclamationLeaseId }),
  };
}
