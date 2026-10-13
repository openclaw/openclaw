import { MessageChannel } from "node:worker_threads";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import type {
  SqliteProfileAdmissionRequest,
  SqliteWriterAdmissionConnection,
  SqliteWriterAdmissionRequest,
  SqliteWriterAdmissionResult,
} from "./sqlite-writer-admission-contract.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

/** Read-only prerequisite service; mixed authority and native settlement remain host-owned. */
export function createSqliteWriterAdmissionService() {
  const lifetimes = new Set<Int32Array<SharedArrayBuffer>>();
  const pool = new WorkerTaskPool<SqliteWriterAdmissionRequest, SqliteWriterAdmissionResult>({
    workerUrl: resolveRuntimeProcessEntrypointUrl("sqliteWriterAdmission"),
    workerClass: "singleton",
    // Connected native readers own their lifetime; ordinary task idle time is not their lease.
    idleTimeoutMs: 0,
    prepareWorker() {
      const lifetime = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      Atomics.store(lifetime, 0, 1);
      lifetimes.add(lifetime);
      return {
        options: { workerData: { admissionLifetime: lifetime } },
        async releaseResources() {
          Atomics.store(lifetime, 0, 0);
          lifetimes.delete(lifetime);
        },
      };
    },
  });
  return {
    async read(request: SqliteProfileAdmissionRequest) {
      // The existing task owner joins failed workers before settling their requests.
      const result = await pool.run(request, { timeoutMs: 30_000 });
      if (typeof result !== "string") {
        throw new Error("SQLite profile admission received a connection result");
      }
      return result;
    },
    async connect(): Promise<SqliteWriterAdmissionConnection> {
      const { port1, port2 } = new MessageChannel();
      try {
        const result = await pool.run(
          { kind: "connect", port: port1 },
          {
            timeoutMs: 30_000,
            transferList: (input) => (input.kind === "connect" ? [input.port] : []),
          },
        );
        if (typeof result === "string" || Atomics.load(result.lifetime, 0) !== 1) {
          throw new Error("SQLite admission service connection is closed");
        }
        return { port: port2, lifetime: result.lifetime };
      } catch (error) {
        port1.close();
        port2.close();
        throw error;
      }
    },
    close() {
      for (const lifetime of lifetimes) {
        Atomics.store(lifetime, 0, 0);
      }
      return pool.close();
    },
  };
}
