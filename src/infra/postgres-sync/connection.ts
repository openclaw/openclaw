import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { receiveMessageOnPort, threadId } from "node:worker_threads";
import { assertEngineStoreExecutionAllowed } from "../database-engine/admission-scope.js";
import { observeDatabaseOperation } from "../database-engine/observation.js";
import type { PostgresSqlConnection, SqlStatement } from "../sql-connection.js";
import { sqlPublicationAnchor } from "../sql-connection.js";
import {
  beginSqliteDatabaseWrite,
  finishSqliteDatabaseWrite,
} from "../sqlite-database-admission.js";
import { withSqlitePostCommitPublications } from "../sqlite-post-commit.js";
import { SqliteWorkerError } from "../sqlite-worker-contract.js";
import { recordWorkerMessage } from "../worker-message-metrics.js";
import {
  createPostgresBridge,
  postgresBridgeReuseKey,
  takePreparedPostgresBridge,
} from "./bridge-prestart.js";
import { takeIdlePostgresBridge, retainIdlePostgresBridge } from "./idle-bridges.js";
import { recordPostgresPoolFailure } from "./pool-state.js";
import {
  decodePostgresError,
  decodePostgresRows,
  isPostgresConnectionError,
  preparePostgresQuery,
  validatePostgresBindings,
  type BridgeReply,
  type BridgeCommand,
  type PostgresResult,
  type PostgresBridge,
} from "./protocol.js";
import { runPostgresTransactionSync } from "./transaction.js";

export class PostgresSyncConnection implements PostgresSqlConnection {
  isOpen = true;
  isTransaction = false;
  mutationRevision = 0;
  readonly advisoryLockKey: bigint;
  private bridge?: PostgresBridge;
  private idleCheckout?: "reconnect" | "validate";
  private readonly bridgeParameters: Parameters<typeof createPostgresBridge>[0];
  private failure: Error | undefined;
  private outcomeUnknown = true;
  private readOnlyTransaction = false;
  // Read handles can share an anchor, but only its writing handle may settle the receipt.
  private pendingWrite = false;
  private readonly mainThread = threadId === 0;
  private readonly reuseKey?: string;

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
    this.bridgeParameters = { url, schema, storeId, ...options };
    this.reuseKey = options?.reuse ? postgresBridgeReuseKey(this.bridgeParameters) : undefined;
    this.connect();
  }

  private connect(): PostgresBridge {
    const idle = this.reuseKey ? takeIdlePostgresBridge(this.reuseKey) : undefined;
    const bridge =
      idle?.bridge ??
      takePreparedPostgresBridge(this.bridgeParameters) ??
      createPostgresBridge(this.bridgeParameters);
    this.bridge = bridge;
    this.idleCheckout = idle ? (idle.validate ? "validate" : "reconnect") : undefined;
    bridge.port.unref();
    if (idle) {
      return bridge;
    }
    try {
      this.request({ operation: "connect", schema: this.schema });
    } catch (error) {
      this.isOpen = false;
      this.isTransaction = false;
      this.bridge = undefined;
      bridge.port.close();
      throw error;
    }
    return bridge;
  }

  runTransaction<T>(
    operation: () => T,
    options?: { withCommit?: (commit: () => void) => void },
    ...modes: [readOnly?: boolean, reserved?: boolean]
  ): T {
    return runPostgresTransactionSync(this, operation, options, ...modes);
  }

  readRecoveryGeneration(lock = false): string {
    return this.request(
      { operation: "recovery-generation", schema: this.schema, storeId: this.storeId, lock },
      false,
    );
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
    const bridge = this.bridge;
    if (bridge?.nextStep && !this.failure.message.includes(bridge.nextStep)) {
      this.failure.message += ` Run ${bridge.nextStep}.`;
    }
    if (bridge && Atomics.load(bridge.service, 1)) {
      recordPostgresPoolFailure(this.failure);
    }
    this.isOpen = false;
    this.isTransaction = false;
    bridge?.port.close();
    this.bridge = undefined;
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
    const bridge = this.bridge ?? this.connect();
    this.outcomeUnknown = outcomeUnknown;
    const id = ++bridge.requestId;
    if (id > 2_147_483_647) {
      throw this.loseConnection();
    }
    const deadline = performance.now() + 120_000;
    // A failed or unsettled request cannot reuse an earlier idle observation.
    bridge.inTransaction = undefined;
    const reconnectIfIdle =
      this.idleCheckout !== undefined &&
      (request.operation === "query" || request.operation === "recovery-generation");
    const validateIfIdle = reconnectIfIdle && this.idleCheckout === "validate";
    this.idleCheckout = undefined;
    bridge.port.postMessage(
      {
        ...request,
        ...(reconnectIfIdle ? { reconnectIfIdle } : {}),
        ...(validateIfIdle ? { validateIfIdle } : {}),
        id,
      },
      [],
    );
    recordWorkerMessage("sqlite_request", "to_worker");
    // Reply notifications belong to this connection; peer death is checked between slices.
    for (
      let observed = Atomics.load(bridge.control, 0);
      observed !== id;
      observed = Atomics.load(bridge.control, 0)
    ) {
      if (Atomics.load(bridge.service, 1)) {
        throw this.loseConnection();
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        Atomics.store(bridge.service, 1, 1);
        Atomics.notify(bridge.service, 1);
        throw this.loseConnection();
      }
      Atomics.wait(bridge.control, 0, observed, Math.min(remaining, 50));
    }
    const reply: BridgeReply | undefined = receiveMessageOnPort(bridge.port)?.message;
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
      bridge.inTransaction = !reply.reusable;
      return reply.reusable;
    }
    bridge.inTransaction = "generation" in reply ? reply.inTransaction : reply.result.inTransaction;
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
      { operation: "query", schema: this.schema, sql, parameters },
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

  /** Release only the idle backend; the logical reader keeps its admitted facts and anchor. */
  releaseIdleTransport(): void {
    const bridge = this.bridge;
    if (!this.isOpen || !bridge || !this.reuseKey || this.isTransaction) {
      return;
    }
    let retained = false;
    try {
      if (bridge.inTransaction === false || this.request({ operation: "release" })) {
        retainIdlePostgresBridge(this.reuseKey, bridge);
        retained = true;
      } else {
        this.isOpen = false;
        this.finishWrite();
      }
    } finally {
      this.bridge = undefined;
      if (!retained) {
        bridge.port.close();
      }
    }
  }

  close(): void {
    if (!this.isOpen) {
      return;
    }
    try {
      if (this.reuseKey && !this.isTransaction) {
        this.releaseIdleTransport();
      } else if (this.bridge) {
        this.request({ operation: "close" });
      }
    } finally {
      this.finishWrite();
      this.isOpen = false;
      this.isTransaction = false;
      this.bridge?.port.close();
      this.bridge = undefined;
    }
  }
}
