import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  MessageChannel,
  receiveMessageOnPort,
  threadId,
  Worker,
  type MessagePort,
} from "node:worker_threads";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { assertEngineStoreExecutionAllowed } from "../database-engine/admission-scope.js";
import { observeDatabaseOperation } from "../database-engine/observation.js";
import {
  POSTGRES_CONNECT_TIMEOUT_MS,
  POSTGRES_LOCK_TIMEOUT_MS,
  POSTGRES_STATEMENT_TIMEOUT_MS,
} from "../database-engine/policy.js";
import { resolveRuntimeProcessEntrypointUrl } from "../runtime-process-url.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../runtime-worker-url.js";
import type { PostgresSqlConnection, SqlStatement } from "../sql-connection.js";
import { sqlPublicationAnchor } from "../sql-connection.js";
import {
  beginSqliteDatabaseWrite,
  finishSqliteDatabaseWrite,
} from "../sqlite-database-admission.js";
import { withSqlitePostCommitPublications } from "../sqlite-post-commit.js";
import { SqliteWorkerError } from "../sqlite-worker-contract.js";
import { recordWorkerMessage } from "../worker-message-metrics.js";
import { takeIdlePostgresBridge, retainIdlePostgresBridge } from "./idle-bridges.js";
import {
  decodePostgresError,
  decodePostgresRows,
  isPostgresConnectionError,
  preparePostgresQuery,
  validatePostgresBindings,
  type BridgeReply,
  type BridgeCommand,
  type PostgresResult,
} from "./protocol.js";
import { runPostgresTransactionSync } from "./transaction.js";

export class PostgresSyncConnection implements PostgresSqlConnection {
  isOpen = true;
  isTransaction = false;
  mutationRevision = 0;
  readonly advisoryLockKey: bigint;
  private readonly port: MessagePort;
  private readonly control: Int32Array;
  private readonly worker: Worker;
  private failure: Error | undefined;
  private requestId = 0;
  private outcomeUnknown = true;
  private readOnlyTransaction = false;
  // Read handles can share an anchor, but only its writing handle may settle the receipt.
  private pendingWrite = false;
  private readonly mainThread = threadId === 0;
  private readonly reuseKey?: string;
  private readonly onWorkerError = () => this.loseConnection();

  constructor(
    url: string,
    readonly schema: string,
    readonly anchor: DatabaseSync,
    readonly storeId: string,
    options?: {
      lockTimeoutMs?: number;
      statementTimeoutMs?: number;
      reuse?: boolean;
    },
  ) {
    assertEngineStoreExecutionAllowed();
    Object.defineProperty(this, Symbol.for("openclaw.postgres-sync-connection"), { value: true });
    this.advisoryLockKey = createHash("sha256").update(storeId).digest().readBigInt64BE();
    const lockTimeoutMs = options?.lockTimeoutMs ?? POSTGRES_LOCK_TIMEOUT_MS;
    const statementTimeoutMs = options?.statementTimeoutMs ?? POSTGRES_STATEMENT_TIMEOUT_MS;
    this.reuseKey = options?.reuse
      ? sha256Hex(JSON.stringify([url, schema, storeId, lockTimeoutMs, statementTimeoutMs]))
      : undefined;
    const idle = this.reuseKey ? takeIdlePostgresBridge(this.reuseKey) : undefined;
    if (idle) {
      this.port = idle.port;
      this.control = idle.control;
      this.worker = idle.worker;
      this.requestId = idle.requestId;
    } else {
      const { port1, port2 } = new MessageChannel();
      this.port = port1;
      this.control = new Int32Array(new SharedArrayBuffer(8));
      const workerUrl = resolveRuntimeProcessEntrypointUrl("postgresBridge");
      this.worker = new Worker(workerUrl, {
        workerData: {
          port: port2,
          signal: this.control.buffer,
          url,
          schema,
          connectTimeoutMs: POSTGRES_CONNECT_TIMEOUT_MS,
          lockTimeoutMs,
          statementTimeoutMs,
        },
        transferList: [port2],
        execArgv: resolveRuntimeWorkerThreadExecArgv(workerUrl),
      });
    }
    this.worker.on("error", this.onWorkerError);
    this.worker.unref();
    this.port.unref();
    try {
      this.request({ operation: "connect" });
    } catch (error) {
      this.isOpen = false;
      this.worker.off("error", this.onWorkerError);
      this.port.close();
      void this.worker.terminate();
      throw error;
    }
  }

  runTransaction<T>(
    operation: () => T,
    options?: { withCommit?: (commit: () => void) => void },
    ...modes: [readOnly?: boolean, reserved?: boolean]
  ): T {
    return runPostgresTransactionSync(this, operation, options, ...modes);
  }

  readRecoveryGeneration(lock = false): string {
    return this.request({ operation: "recovery-generation", storeId: this.storeId, lock }, false);
  }

  private loseConnection(): Error {
    if (!this.failure && this.outcomeUnknown) {
      // The write may have committed, so invalidate anchor caches before reconnecting.
      this.pendingWrite = true;
      beginSqliteDatabaseWrite(sqlPublicationAnchor(this), true);
    }
    this.finishWrite();
    this.failure ??= this.outcomeUnknown
      ? new SqliteWorkerError("PostgreSQL connection lost; outcome unknown", "outcome-unknown")
      : new Error("PostgreSQL connection lost; transaction rolled back");
    this.isOpen = false;
    this.isTransaction = false;
    this.worker.off("error", this.onWorkerError);
    this.port.close();
    void this.worker.terminate();
    return this.failure;
  }

  private finishWrite(): void {
    if (this.pendingWrite) {
      this.pendingWrite = false;
      finishSqliteDatabaseWrite(sqlPublicationAnchor(this));
    }
  }

  private assertOpen(): void {
    if (this.failure) {
      throw this.failure;
    }
    if (!this.isOpen) {
      throw new Error("PostgreSQL connection is closed");
    }
  }

  private request(
    request: Extract<BridgeCommand, { operation: "recovery-generation" }>,
    outcomeUnknown?: boolean,
  ): string;
  private request(request: Extract<BridgeCommand, { operation: "release" }>): boolean;
  private request(
    request: Exclude<BridgeCommand, { operation: "recovery-generation" | "release" }>,
    outcomeUnknown?: boolean,
  ): PostgresResult;
  private request(
    request: BridgeCommand,
    outcomeUnknown = true,
  ): PostgresResult | string | boolean {
    if (this.mainThread && request.operation !== "close" && request.operation !== "release") {
      assertEngineStoreExecutionAllowed();
    }
    this.assertOpen();
    this.outcomeUnknown = outcomeUnknown;
    const id = ++this.requestId;
    if (id > 2_147_483_647) {
      throw this.loseConnection();
    }
    const deadline = performance.now() + 120_000;
    this.port.postMessage({ ...request, id }, []);
    recordWorkerMessage("sqlite_request", "to_worker");
    // A notify for an earlier request can arrive after this request starts.
    let observed: number;
    while ((observed = Atomics.load(this.control, 0)) !== id) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw this.loseConnection();
      }
      Atomics.wait(this.control, 0, observed, remaining);
    }
    const reply: BridgeReply | undefined = receiveMessageOnPort(this.port)?.message;
    if (reply) {
      recordWorkerMessage("sqlite_reply", "from_worker");
    }
    if (!reply || reply.id !== id) {
      throw this.loseConnection();
    }
    if ("error" in reply) {
      if (request.operation === "connect") {
        throw decodePostgresError(reply.error);
      }
      if (isPostgresConnectionError(reply.error.code)) {
        throw this.loseConnection();
      }
      if (request.operation === "query" && /^\s*COMMIT\b/i.test(request.sql)) {
        this.isTransaction = false;
        this.finishWrite();
      }
      throw decodePostgresError(reply.error);
    }
    if ("reusable" in reply) {
      return reply.reusable;
    }
    return "generation" in reply ? reply.generation : reply.result;
  }

  query(sql: string, parameters: readonly SQLInputValue[] = [], readBigInts = false) {
    return observeDatabaseOperation("postgres", "statement", sql, () =>
      this.execute(preparePostgresQuery(sql), parameters, readBigInts),
    );
  }

  private execute(
    { sql, mutation: hintedMutation }: ReturnType<typeof preparePostgresQuery>,
    parameters: readonly SQLInputValue[],
    readBigInts: boolean,
  ) {
    validatePostgresBindings(parameters);
    const wasTransaction = this.isTransaction;
    // A later statement in a combined BEGIN request can fail after BEGIN succeeded.
    if (/^\s*BEGIN\b/i.test(sql)) {
      this.isTransaction = true;
    }
    const result = this.request(
      { operation: "query", sql, parameters },
      !wasTransaction || /^\s*COMMIT\b/i.test(sql),
    );
    const readOnly = this.readOnlyTransaction;
    this.isTransaction = result.inTransaction;
    this.readOnlyTransaction =
      this.isTransaction && (readOnly || /^\s*BEGIN\b[^;]*\bREAD\s+ONLY\b/i.test(sql));
    if (/^\s*COMMIT\s*;?\s*$/i.test(sql) && result.command !== "COMMIT") {
      this.finishWrite();
      throw new Error("PostgreSQL transaction rolled back instead of committing");
    }
    const mutation =
      result.mutation === "unscoped" || hintedMutation === "unscoped"
        ? "unscoped"
        : (result.mutation ?? hintedMutation);
    const mutated = mutation !== undefined;
    if (mutated) {
      if (readOnly || this.readOnlyTransaction) {
        // A snapshot must never publish another handle's pending receipt on the shared anchor.
        throw new Error("PostgreSQL read snapshot cannot execute a mutation");
      }
      // Like SQLite's mutation witness, rollback does not rewind local cache invalidation.
      this.mutationRevision++;
      // Typed DML borrows its owner's scopes; schema and raw writes fence every reader.
      this.pendingWrite = true;
      beginSqliteDatabaseWrite(sqlPublicationAnchor(this), mutation === "unscoped");
    }
    if (!this.isTransaction && (mutated || wasTransaction)) {
      withSqlitePostCommitPublications(sqlPublicationAnchor(this), () => {
        // No pending mutation means no receipt, including empty writable transactions.
        this.finishWrite();
      });
    }
    this.outcomeUnknown = !this.isTransaction;
    return {
      rows: decodePostgresRows(result, readBigInts),
      rowCount: result.rowCount,
      columns: result.fields.map(({ name }) => ({ name })),
    };
  }

  exec(sql: string): void {
    this.query(sql);
  }

  prepare(sql: string): SqlStatement {
    this.assertOpen();
    const prepared = preparePostgresQuery(sql);
    let readBigInts = false;
    let columns: { name: string }[] = [];
    const execute = (parameters: SQLInputValue[]) => {
      const result = observeDatabaseOperation("postgres", "statement", sql, () =>
        this.execute(prepared, parameters, readBigInts),
      );
      columns = result.columns;
      return result;
    };
    return {
      get: (...parameters) => execute(parameters).rows[0],
      all: (...parameters) => execute(parameters).rows,
      // This pilot buffers results; server-side cursors are outside its scope.
      iterate: (...parameters) => execute(parameters).rows[Symbol.iterator](),
      run: (...parameters) => ({ changes: execute(parameters).rowCount, lastInsertRowid: 0 }),
      // pg only supplies column metadata with a result, so it appears after execution.
      columns: () => columns,
      setReadBigInts: (enabled) => {
        readBigInts = enabled;
      },
    };
  }

  close(): void {
    if (!this.isOpen) {
      return;
    }
    let retained = false;
    try {
      if (this.reuseKey && !this.isTransaction) {
        const reusable = this.request({ operation: "release" });
        if (reusable) {
          this.worker.off("error", this.onWorkerError);
          retainIdlePostgresBridge(this.reuseKey, {
            port: this.port,
            control: this.control,
            worker: this.worker,
            requestId: this.requestId,
          });
          retained = true;
          return;
        }
      } else {
        this.request({ operation: "close" });
      }
      // Wait for the worker's exit notification after its client and ports close.
      if (Atomics.wait(this.control, 1, 0, 120_000) === "timed-out") {
        throw this.loseConnection();
      }
    } finally {
      this.finishWrite();
      this.isOpen = false;
      this.isTransaction = false;
      if (!retained) {
        this.worker.off("error", this.onWorkerError);
        this.port.close();
      }
    }
  }
}
