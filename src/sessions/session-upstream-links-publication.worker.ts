import type { EngineConnection } from "../infra/sql-connection.js";
import { deferSqliteWorkerCommitReceipt } from "../infra/sqlite-worker-operation-admission.js";
import { sessionUpstreamPresencePublication } from "./session-upstream-links-publication.js";

export function captureSessionUpstreamMutation<T>(db: EngineConnection, operation: () => T): T {
  const { result, receipt } = sessionUpstreamPresencePublication.capture(db, operation);
  if (receipt.facts.size > 0) {
    deferSqliteWorkerCommitReceipt(db, {
      upstreamPresence: sessionUpstreamPresencePublication.bound(receipt),
    });
  }
  return result;
}
