import { isMainThread } from "node:worker_threads";
import { SqliteWorkerOpenRefusedError } from "../infra/sqlite-worker-operation-admission.js";

export const mainThread = isMainThread;

export function classifyAgentDatabaseOpeningRefusal(error: unknown, preparedLease: unknown) {
  const refused = error instanceof SqliteWorkerOpenRefusedError;
  return {
    deferLeaseRelease: preparedLease !== undefined && !isMainThread && refused,
    closeOutcome: refused ? ("read-only" as const) : undefined,
  };
}
