import type { ProfileAuthorityDescriptor } from "../state/user-profile-authority.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import type { SqliteProfileAdmissionResult } from "./sqlite-writer-admission-contract.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

/** Profile checks alone do not grant a native write or replace the final host COMMIT guard. */
type SqliteProfileAdmissionRequest = {
  kind: "assert-bound-revision" | "read-current-settled-facts";
  authority: ProfileAuthorityDescriptor;
};

/** Read-only prerequisite service; mixed authority and native settlement remain host-owned. */
export function createSqliteWriterAdmissionService() {
  const pool = new WorkerTaskPool<SqliteProfileAdmissionRequest, SqliteProfileAdmissionResult>({
    workerUrl: resolveRuntimeProcessEntrypointUrl("sqliteWriterAdmission"),
    workerClass: "singleton",
  });
  return {
    read(request: SqliteProfileAdmissionRequest) {
      // The existing task owner joins failed workers before settling their requests.
      return pool.run(request, { timeoutMs: 30_000 });
    },
    close: () => pool.close(),
  };
}
