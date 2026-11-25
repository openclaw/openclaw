import { MessageChannel, type MessagePort } from "node:worker_threads";
import { readAgentDatabaseExecutionAuthority } from "../state/openclaw-agent-execution-authority.js";
import type { ProfileAuthorityDescriptor } from "../state/user-profile-authority.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import {
  SqliteWorkerAdmissionTimeoutError,
  SqliteWorkerError,
  type SqliteWorkerExecutionAuthority,
} from "./sqlite-worker-contract.js";
import {
  readSqliteWorkerRequestCustody,
  type SqliteWorkerRequestCustodyDescriptor,
} from "./sqlite-worker-request-custody.js";
import type { SqliteWriterAdmissionResult } from "./sqlite-writer-admission-contract.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

/** Profile checks alone do not grant a native write or replace the final host COMMIT guard. */
type SqliteProfileAdmissionRequest = {
  kind: "assert-bound-revision" | "read-current-settled-facts";
  authority: ProfileAuthorityDescriptor;
};

type SqliteWriterAdmissionConnection = {
  port: MessagePort;
  lifetime: Int32Array<SharedArrayBuffer>;
};

type SqliteWriterAdmissionRequest =
  | SqliteProfileAdmissionRequest
  | { kind: "connect"; port: MessagePort };

/** This checks broker custody only; other authority owners and final COMMIT remain required. */
export function assertSqliteWriterBrokerAdmission(
  connection: SqliteWriterAdmissionConnection,
  custody: SqliteWorkerRequestCustodyDescriptor,
  executionAuthority?: SqliteWorkerExecutionAuthority,
): void {
  const current = () =>
    Atomics.load(connection.lifetime, 0) === 1 &&
    readSqliteWorkerRequestCustody(custody) &&
    (!executionAuthority || readAgentDatabaseExecutionAuthority(executionAuthority));
  if (!current()) {
    throw new SqliteWorkerError("SQLite broker admission is revoked", "closed");
  }
  const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const deadline = process.hrtime.bigint() + 30_000_000_000n;
  connection.port.postMessage({ custody, decision, executionAuthority }, []);
  while (Atomics.load(decision, 0) === 0) {
    const remainingMs = Number(deadline - process.hrtime.bigint()) / 1e6;
    if (remainingMs <= 0) {
      // A late service reply cannot turn an expired request into a grant.
      Atomics.compareExchange(decision, 0, 0, 3);
    } else {
      Atomics.wait(decision, 0, 0, remainingMs);
    }
  }
  const result = Atomics.load(decision, 0);
  if (result === 3) {
    throw new SqliteWorkerAdmissionTimeoutError();
  }
  if (result !== 1 || !current()) {
    throw new SqliteWorkerError("SQLite broker admission is revoked", "closed");
  }
}

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
