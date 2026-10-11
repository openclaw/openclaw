import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  MessageChannel,
  receiveMessageOnPort,
  Worker,
  type MessagePort,
} from "node:worker_threads";
import { resolveRuntimeProcessEntrypointUrl } from "../runtime-process-url.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../runtime-worker-url.js";
import type { SqlConnection, SqlStatement } from "../sql-connection.js";
import {
  beginSqliteDatabaseWrite,
  finishSqliteDatabaseWrite,
} from "../sqlite-database-admission.js";
import { withSqlitePostCommitPublications } from "../sqlite-post-commit.js";
import { SqliteWorkerError } from "../sqlite-worker-contract.js";
import { deferSqliteWorkerCommitReceipt } from "../sqlite-worker-operation-admission.js";
import { currentSqliteWorkerOperationAdmission } from "../sqlite-worker-operation-settlement.js";
import {
  decodePostgresError,
  decodePostgresRows,
  isPostgresConnectionError,
  rewritePostgresPlaceholders,
  validatePostgresBindings,
  type BridgeReply,
  type BridgeCommand,
} from "./protocol.js";

export class PostgresSyncConnection implements SqlConnection {
  isOpen = true;
  isTransaction = false;
  readonly advisoryLockKey: bigint;
  private readonly port: MessagePort;
  private readonly control = new Int32Array(new SharedArrayBuffer(8));
  private readonly worker: Worker;
  private failure: Error | undefined;
  private requestId = 0;
  private outcomeUnknown = true;

  constructor(
    url: string,
    readonly schema: string,
    readonly anchor: DatabaseSync,
    storeId: string,
  ) {
    this.advisoryLockKey = createHash("sha256").update(storeId).digest().readBigInt64BE();
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    const workerUrl = resolveRuntimeProcessEntrypointUrl("postgresBridge");
    this.worker = new Worker(workerUrl, {
      workerData: { port: port2, signal: this.control.buffer, url, schema },
      transferList: [port2],
      execArgv: resolveRuntimeWorkerThreadExecArgv(workerUrl),
    });
    this.worker.on("error", () => this.loseConnection());
    this.worker.unref();
    this.port.unref();
    try {
      this.request({ operation: "connect" });
    } catch (error) {
      this.isOpen = false;
      this.port.close();
      void this.worker.terminate();
      throw error;
    }
  }

  private loseConnection(): Error {
    this.failure ??= this.outcomeUnknown
      ? new SqliteWorkerError("PostgreSQL connection lost; outcome unknown", "outcome-unknown")
      : new Error("PostgreSQL connection lost; transaction rolled back");
    this.isOpen = false;
    this.isTransaction = false;
    this.port.close();
    void this.worker.terminate();
    return this.failure;
  }

  private assertOpen(): void {
    if (this.failure) {
      throw this.failure;
    }
    if (!this.isOpen) {
      throw new Error("PostgreSQL connection is closed");
    }
  }

  private request(request: BridgeCommand, outcomeUnknown = true) {
    this.assertOpen();
    this.outcomeUnknown = outcomeUnknown;
    const id = ++this.requestId;
    if (id > 2_147_483_647) {
      throw this.loseConnection();
    }
    const deadline = performance.now() + 120_000;
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node MessagePort has no targetOrigin.
    this.port.postMessage({ ...request, id });
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
    if (!reply || reply.id !== id) {
      throw this.loseConnection();
    }
    if ("error" in reply) {
      if (isPostgresConnectionError(reply.error.code)) {
        throw this.loseConnection();
      }
      if (request.operation === "query" && /^\s*COMMIT\b/i.test(request.sql)) {
        this.isTransaction = false;
      }
      throw decodePostgresError(reply.error);
    }
    return reply.result;
  }

  query(sql: string, parameters: readonly SQLInputValue[] = [], readBigInts = false) {
    this.assertOpen();
    validatePostgresBindings(parameters);
    const rewrittenSql = rewritePostgresPlaceholders(sql);
    const wasTransaction = this.isTransaction;
    // A later statement in a combined BEGIN request can fail after BEGIN succeeded.
    if (/^\s*BEGIN\b/i.test(sql)) {
      this.isTransaction = true;
    }
    const result = this.request(
      { operation: "query", sql: rewrittenSql, parameters },
      !wasTransaction || /^\s*COMMIT\b/i.test(sql),
    );
    if (
      !wasTransaction &&
      /^(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|COMMENT|GRANT|REVOKE)$/.test(
        result.command ?? "",
      )
    ) {
      // Autocommit writes publish the same anchor receipt as explicit transactions.
      withSqlitePostCommitPublications(this.anchor, () => {
        beginSqliteDatabaseWrite(this.anchor);
        finishSqliteDatabaseWrite(this.anchor);
        if (currentSqliteWorkerOperationAdmission.getStore()?.active) {
          deferSqliteWorkerCommitReceipt(this.anchor, {});
        }
      });
    }
    if (/^\s*(?:COMMIT|ROLLBACK)\s*;?\s*$/i.test(sql)) {
      this.isTransaction = false;
      if (/^\s*COMMIT\b/i.test(sql) && result.command !== "COMMIT") {
        throw new Error("PostgreSQL transaction rolled back instead of committing");
      }
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
    rewritePostgresPlaceholders(sql);
    let readBigInts = false;
    let columns: { name: string }[] = [];
    const execute = (parameters: SQLInputValue[]) => {
      const result = this.query(sql, parameters, readBigInts);
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
    try {
      this.request({ operation: "close" });
      // Wait for the worker's exit notification after its client and ports close.
      if (Atomics.wait(this.control, 1, 0, 120_000) === "timed-out") {
        throw this.loseConnection();
      }
    } finally {
      this.isOpen = false;
      this.isTransaction = false;
      this.port.close();
    }
  }
}
