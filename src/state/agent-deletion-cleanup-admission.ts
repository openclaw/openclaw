import { isDeepStrictEqual } from "node:util";
import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteWorkerAdmissionRequest } from "../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../infra/sqlite-worker-operation-settlement.js";
import { getAgentDeletionDatabaseCleanup } from "./agent-deletion-cleanup.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";

/** Bind the request's cleanup owner, including accepted native work, before transferring a grant. */
export function captureAgentDeletionCleanupAdmission(
  options: OpenClawAgentDatabaseOptions,
  operation: RetainedWorkerTransactionAdmission,
  assertSourceCurrent: () => void,
) {
  const cleanup = getAgentDeletionDatabaseCleanup(options);
  if (!cleanup?.worker) {
    return undefined;
  }
  const worker = cleanup.worker;
  cleanup.assertCurrentHost();
  return {
    guard: worker.guard,
    assertCurrent: cleanup.assertCurrentHost,
    authorize(request: SqliteWorkerAdmissionRequest): boolean {
      const facts = request.facts;
      if (
        request.stage !== "prepare" ||
        !isRecord(facts) ||
        (facts.kind !== "agent-deletion-current" && facts.kind !== "agent-deletion-lease")
      ) {
        return false;
      }
      assertSourceCurrent();
      cleanup.assertCurrentHost();
      if (!isDeepStrictEqual(facts.guard, worker.guard)) {
        throw new Error("Agent deletion request differs from its live cleanup owner");
      }
      if (facts.kind === "agent-deletion-lease") {
        if (!(facts.port instanceof MessagePort)) {
          throw new Error("Agent deletion lost its lease admission handoff port");
        }
        const leased = worker.lease.createAdmission(operation);
        try {
          facts.port.postMessage(leased.admission.port, [leased.admission.port]);
          void operation.settled.then(() => leased.admission.finish());
        } catch (error) {
          leased.admission.finish();
          throw error;
        } finally {
          facts.port.close();
        }
      }
      return true;
    },
  };
}
