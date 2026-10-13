import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import type {
  SqliteProfileAdmissionRequest,
  SqliteProfileAdmissionResult,
} from "./sqlite-writer-admission-contract.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

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

export function runSqliteProfileAdmission(
  request: SqliteProfileAdmissionRequest,
): Promise<SqliteProfileAdmissionResult> {
  const owner = resolveGlobalSingleton<{
    service?: ReturnType<typeof createSqliteWriterAdmissionService>;
    closing?: Promise<void>;
  }>(
    Symbol.for("openclaw.sqliteWriterAdmission"),
    () => ({}),
    (state) => {
      state.closing ??= (async () => {
        await state.service?.close();
        state.service = undefined;
      })().finally(() => {
        state.closing = undefined;
      });
      return state.closing;
    },
  );
  if (owner.closing) {
    return Promise.reject(new Error("SQLite admission service is closing"));
  }
  return (owner.service ??= createSqliteWriterAdmissionService()).read(request);
}
