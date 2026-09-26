import { channel } from "node:diagnostics_channel";
import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../../infra/sqlite-handle-lifecycle.js";
import { sqliteReaderDatabasePathKey } from "../../infra/sqlite-reader-lifecycle.js";
import {
  publishSqliteWalCheckpointObservation,
  type SqliteWalCheckpointSnapshot,
} from "../../infra/sqlite-wal-checkpoint.js";
import { captureStateDatabaseCoordinatorRuntime } from "../../infra/state-database-coordinator.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { OpenClawAgentDatabaseClaim } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabaseWorkerLeaseReceipt } from "../../state/openclaw-agent-db-lease.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-lifecycle.js";
import { cleanupRetiredAgentDatabaseLease } from "../../state/openclaw-agent-execution-cleanup.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import {
  publishOpenClawStateDatabaseWorkerAdmission,
  registerOpenClawStateDatabaseAsyncResource,
} from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  createSqliteTranscriptArchiveWorker,
  runExclusiveSqliteTranscriptArchiveWorker,
} from "./session-accessor.sqlite-archive.js";
import {
  captureCanonicalValidationWorkerPool,
  startCanonicalValidationTask,
  type CanonicalWorkerPool,
} from "./session-accessor.sqlite-canonical-worker-pool.js";
import type {
  CanonicalSessionValidationResult,
  SqliteSessionReclamationDiagnostics,
} from "./session-accessor.sqlite-contract.js";
import type {
  SqliteArchiveReclamationPlan,
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { revokeSqliteReclamationCommit } from "./session-accessor.sqlite-reclamation-commit.js";
import { logSqliteReclamationWorkerOutcome } from "./session-accessor.sqlite-reclamation-worker-diagnostics.js";
import {
  withSqliteMutationWorkerCoordination,
  type SqliteMutationWorkerCoordination,
} from "./session-accessor.sqlite-worker-coordination.js";
import {
  runSqliteMutationWorkerRequest,
  type SqliteMutationWorkerMessage,
  type SqliteMutationWorkerValidationOwner,
  type SqliteWorkerWriteAdmission,
} from "./session-accessor.sqlite-worker-request.js";
import {
  observeSqliteMutationWorkerEnd,
  sqliteMutationWorkerThreadId,
  terminateSqliteMutationWorker,
  type SqliteMutationWorkerTransport,
} from "./session-accessor.sqlite-worker-transport.js";

type DatabaseOptions = SqliteSessionReclamationPlan["databaseOptions"];
export type SqliteReclamationWorkerRequest = {
  type: "reclaim";
  operationId: number;
  commitGate: SharedArrayBuffer;
  plan: SqliteArchiveReclamationPlan;
  coordination: SqliteMutationWorkerCoordination;
};
export type SqliteReclamationWorkerCloseRequest = {
  type: "close";
  operationId: number;
  coordination: SqliteMutationWorkerCoordination;
};
export type SqliteCanonicalValidationWorkerRequest = {
  type: "canonical-validation";
  operationId: number;
  commitGate: SharedArrayBuffer;
  databaseOptions: DatabaseOptions;
  maxRows: number;
  maxBytes: number;
  initializeCanonicalValidation: boolean;
  coordination: SqliteMutationWorkerCoordination;
};
type SqliteMutationWorkerRequest =
  | SqliteReclamationWorkerRequest
  | SqliteCanonicalValidationWorkerRequest;
type MutationRunParams<Result> = {
  claim: OpenClawAgentDatabaseClaim;
  validationOwner?: SqliteMutationWorkerValidationOwner;
  diagnostics?: SqliteSessionReclamationDiagnostics;
  commitGate: SharedArrayBuffer;
  onCommitRequest: () => void;
  withWriteAdmission: SqliteWorkerWriteAdmission<Result>;
};
type WorkerCleanup = { cleanupWarnings: string[]; settled: boolean };
export type SqliteReclamationWorkerMessage =
  | SqliteMutationWorkerMessage<SqliteSessionReclamationResult>
  | { type: "lease"; receipt: OpenClawAgentDatabaseWorkerLeaseReceipt }
  | { type: "checkpoint"; operationId: number; snapshot: SqliteWalCheckpointSnapshot }
  | ({ type: "closed" } & WorkerCleanup);

const log = createSubsystemLogger("session-sqlite");
type ReclamationWorkerSlot = {
  worker?: SqliteReclamationWorker;
  execution?: CanonicalWorkerPool;
  retain?: (worker: SqliteReclamationWorker) => void;
  retire?: (worker: SqliteReclamationWorker) => void;
};
const retained = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionReclamationWorkers"),
  () => new Map<string, SqliteReclamationWorker>(),
);

/** The global archive FIFO bounds ordinary reclamation's whole-buffer heaps. */
export function withSqliteReclamationWorker<T>(
  options: DatabaseOptions,
  claim: OpenClawAgentDatabaseClaim,
  run: (worker: SqliteReclamationWorker) => Promise<T>,
  assertRequestCurrent: () => void,
  signal?: AbortSignal,
): Promise<T> {
  return runExclusiveSqliteTranscriptArchiveWorker(() => {
    const key = sqliteReaderDatabasePathKey(options.path);
    return useReclamationWorker(
      {
        worker: retained.get(key),
        retain: (worker) => retained.set(key, worker),
        retire: (worker) => {
          if (retained.get(key) === worker) {
            retained.delete(key);
          }
        },
      },
      options,
      claim,
      run,
      assertRequestCurrent,
    );
  }, signal);
}

/** Startup bounds these scopes; each keeps one worker through certification and native close. */
export async function withSqliteCanonicalValidationWorker<T>(
  run: (withWorker: typeof withSqliteReclamationWorker) => Promise<T>,
): Promise<T> {
  const slot: ReclamationWorkerSlot = { execution: captureCanonicalValidationWorkerPool() };
  const queue = new KeyedAsyncQueue();
  let closed = false;
  try {
    return await run((options, claim, consume, assertCurrent) =>
      queue.enqueue("canonical-validation", () => {
        if (closed) {
          throw new Error("Canonical validation Worker scope is closed");
        }
        return useReclamationWorker(slot, options, claim, consume, assertCurrent);
      }),
    );
  } finally {
    closed = true;
    await queue.enqueue("canonical-validation", async () => {
      await slot.worker?.close();
    });
  }
}

async function useReclamationWorker<T>(
  slot: ReclamationWorkerSlot,
  options: DatabaseOptions,
  claim: OpenClawAgentDatabaseClaim,
  run: (worker: SqliteReclamationWorker) => Promise<T>,
  assertRequestCurrent: () => void,
): Promise<T> {
  assertRequestCurrent();
  claim.assertCurrent();
  if (slot.worker && !slot.worker.matches(options, claim)) {
    await slot.worker.close();
    slot.worker = undefined;
  }
  assertRequestCurrent();
  const worker = (slot.worker ??= new SqliteReclamationWorker(
    options,
    claim.identity,
    slot.execution,
    slot.retire,
  ));
  slot.retain?.(worker);
  try {
    return await worker.use(() => run(worker));
  } catch (error) {
    // An uncertain mutation is never replayed; a replacement serves only a later request.
    try {
      await worker.close();
      if (slot.worker === worker) {
        slot.worker = undefined;
      }
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "SQLite reclamation and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

/** Retains only the admitted connection; each caller owns its plan, claim and commit gate. */
export class SqliteReclamationWorker {
  private transport?: SqliteMutationWorkerTransport;
  private workerThreadId?: number;
  private ended?: Promise<void>;
  private nativeExitProven = false;
  private taskCustodyReleased = false;
  private closeRequested = false;
  private healthyCloseAcknowledged = false;
  private failure?: Error;
  private cleanup?: WorkerCleanup;
  private readonly closed = createDeferredCore();
  private lease?: OpenClawAgentDatabaseWorkerLeaseReceipt;
  private closing?: Promise<void>;
  private active?: Promise<unknown>;
  private commitGate?: SharedArrayBuffer;
  private revoked = false;
  private retired = false;
  private idle?: NodeJS.Timeout;
  private operationId = 0;
  private readonly unregisterAgent: () => void;
  private readonly unregisterState: () => void;
  private readonly stateContext;
  private readonly beforeExit = () => {
    void this.close().catch((error: unknown) => log.error(String(error)));
  };
  private readonly onMemoryPressure = () => this.retireIfIdle();

  constructor(
    private readonly options: DatabaseOptions,
    private readonly identity: OpenClawAgentDatabaseClaim["identity"],
    private readonly execution?: CanonicalWorkerPool,
    private readonly onRetired?: (worker: SqliteReclamationWorker) => void,
  ) {
    this.options = structuredClone(options);
    this.stateContext = captureOpenClawStateWorkerContext({ env: options.env });
    this.unregisterAgent = registerOpenClawAgentDatabaseAsyncResource({
      agentId: options.agentId,
      path: options.path,
      revoke: () => this.revoke(),
      close: () => this.close(),
    });
    try {
      this.unregisterState = registerOpenClawStateDatabaseAsyncResource({
        close: async (closingIdentity) => {
          if (
            !closingIdentity ||
            closingIdentity.key === this.stateContext.admission.identity.key
          ) {
            await this.close();
          }
        },
      });
    } catch (error) {
      this.unregisterAgent();
      throw error;
    }
    // Failed exit cleanup retains custody for explicit retries without restarting the event loop.
    process.once("beforeExit", this.beforeExit);
  }

  matches(options: DatabaseOptions, claim: OpenClawAgentDatabaseClaim): boolean {
    return (
      !this.revoked &&
      isDeepStrictEqual(this.options, options) &&
      this.identity === claim.identity &&
      resolveOpenClawStateSqlitePath(options.env) === this.stateContext.admission.databasePath &&
      captureStateDatabaseCoordinatorRuntime().directory ===
        this.stateContext.coordinatorRuntime.directory
    );
  }

  assertCurrent(options: DatabaseOptions, claim: OpenClawAgentDatabaseClaim): void {
    claim.assertCurrent();
    this.stateContext.admission.assertCurrent();
    if (this.failure) {
      throw this.failure;
    }
    if (!this.matches(options, claim)) {
      throw new Error("SQLite session reclamation database owner is no longer current");
    }
    this.assertPathCurrent();
  }

  private assertPathCurrent(): void {
    const file = statSync(this.options.path, { bigint: true });
    if (`${file.dev}:${file.ino}` !== this.identity) {
      throw new Error("SQLite session reclamation database path was replaced");
    }
  }

  async use<T>(run: () => Promise<T>): Promise<T> {
    clearTimeout(this.idle);
    this.transport?.channel.ref();
    const operation = Promise.resolve().then(run);
    this.active = operation;
    try {
      return await operation;
    } finally {
      this.active = undefined;
      if (!this.revoked) {
        this.transport?.channel.unref();
        this.idle = setTimeout(this.beforeExit, SQLITE_IDLE_HANDLE_TTL_MS);
        this.idle.unref();
      }
    }
  }

  retireIfIdle(): void {
    if (this.transport && this.idle && !this.active && !this.revoked) {
      void this.close().catch((error: unknown) => log.error(String(error)));
    }
  }

  run(
    params: MutationRunParams<SqliteSessionReclamationResult> & {
      plan: SqliteArchiveReclamationPlan;
      transferList: ArrayBuffer[];
    },
  ): Promise<SqliteSessionReclamationResult> {
    return this.runRequest({
      ...params,
      databaseOptions: params.plan.databaseOptions,
      kind: params.plan.kind,
      sessionId:
        params.plan.kind === "entry"
          ? params.plan.preparedTargetSnapshot[0]?.entry.sessionId
          : params.plan.kind === "historical-generation" || params.plan.kind === "history-eviction"
            ? params.plan.sessionId
            : undefined,
      request: (operationId, coordination) => ({
        type: "reclaim",
        operationId,
        commitGate: params.commitGate,
        plan: params.plan,
        coordination,
      }),
    });
  }

  runCanonicalValidation(
    params: MutationRunParams<CanonicalSessionValidationResult> & {
      databaseOptions: DatabaseOptions;
      maxRows: number;
      maxBytes: number;
      initializeCanonicalValidation: boolean;
    },
  ): Promise<CanonicalSessionValidationResult> {
    return this.runRequest({
      ...params,
      kind: "canonical-validation",
      transferList: [],
      request: (operationId, coordination) => ({
        type: "canonical-validation",
        operationId,
        commitGate: params.commitGate,
        databaseOptions: params.databaseOptions,
        maxRows: params.maxRows,
        maxBytes: params.maxBytes,
        initializeCanonicalValidation: params.initializeCanonicalValidation,
        coordination,
      }),
    });
  }

  private async runRequest<Result>(
    params: MutationRunParams<Result> & {
      databaseOptions: DatabaseOptions;
      kind: string;
      sessionId?: string;
      request: (
        operationId: number,
        coordination: SqliteMutationWorkerCoordination,
      ) => SqliteMutationWorkerRequest;
      transferList: ArrayBuffer[];
    },
  ): Promise<Result> {
    const startedAt = performance.now();
    this.assertCurrent(params.databaseOptions, params.claim);
    const transport = (this.transport ??= await this.start());
    this.assertCurrent(params.databaseOptions, params.claim);
    const worker = transport.channel;
    if (params.diagnostics) {
      params.diagnostics.workerThreadId = this.workerThreadId;
    }
    const operationId = ++this.operationId;
    this.commitGate = params.commitGate;
    let exitCode: number | undefined;
    const operation = withSqliteMutationWorkerCoordination(
      this.stateContext,
      transport,
      operationId,
      (coordination) =>
        runSqliteMutationWorkerRequest<Result>({
          transport,
          operationId,
          completion: "result",
          getFailure: () => this.failure,
          onExit: (code) => {
            exitCode = code;
          },
          onCommitRequest: params.onCommitRequest,
          withWriteAdmission: params.withWriteAdmission,
          validationOwner: params.validationOwner,
          dispatch: () =>
            worker.postMessage(params.request(operationId, coordination), [
              ...params.transferList,
              ...(coordination.stateLifecycle ? [coordination.stateLifecycle] : []),
            ]),
        }),
    );
    const observeCompletion = (outcome: "resolved" | "rejected", failure?: unknown) =>
      logSqliteReclamationWorkerOutcome({
        startedAt,
        outcome,
        failure,
        kind: params.diagnostics?.kind ?? params.kind,
        workerThreadId: this.workerThreadId,
        exitCode,
        sessionId: params.sessionId,
      });
    void operation
      .then(
        () => observeCompletion("resolved"),
        (error: unknown) => observeCompletion("rejected", error),
      )
      .catch(() => {});
    return operation.finally(() => {
      this.commitGate = undefined;
    });
  }

  private async start(): Promise<SqliteMutationWorkerTransport> {
    const transport: SqliteMutationWorkerTransport = this.execution
      ? await startCanonicalValidationTask(this.execution, this.options)
      : {
          kind: "dedicated",
          channel: createSqliteTranscriptArchiveWorker({
            type: "sqlite-transcript-archive-v2",
            operation: "reclaim",
            databaseOptions: this.options,
          }),
        };
    const worker = transport.channel;
    this.workerThreadId = sqliteMutationWorkerThreadId(transport);
    if (transport.kind === "pooled") {
      this.operationId = transport.initialOperationId;
    }
    worker.on("message", (message: SqliteReclamationWorkerMessage) => {
      if (message.type === "checkpoint") {
        this.observeCheckpoint(message);
      } else if (message.type === "closed") {
        this.cleanup = message;
        this.healthyCloseAcknowledged = this.closeRequested && message.settled;
        this.closed.resolve();
      } else if (message.type === "lease") {
        try {
          // First creation binds the captured path admission; replacement still revokes it.
          publishOpenClawStateDatabaseWorkerAdmission(this.stateContext.admission);
        } catch (error) {
          this.failure ??= toStringifiedError(error);
        }
        try {
          // Revoked read authority cannot discard an already acquired exact cleanup receipt.
          if (
            message.receipt.agentId !== this.options.agentId ||
            message.receipt.path !== this.options.path ||
            message.receipt.ownerPid !== process.pid ||
            message.receipt.sharedStateIdentity !== this.stateContext.admission.identity.key ||
            (this.lease && !isDeepStrictEqual(this.lease, message.receipt))
          ) {
            throw new Error("SQLite reclamation Worker changed its lease receipt");
          }
          this.lease = message.receipt;
        } catch (error) {
          this.failure ??= toStringifiedError(error);
        }
        if (this.failure) {
          this.requestTermination(transport);
        }
      }
    });
    worker.once("error", (error) => {
      this.failure ??= toStringifiedError(error);
    });
    worker.once("messageerror", (error) => {
      this.failure ??= toStringifiedError(error);
      this.requestTermination(transport);
    });
    this.ended = new Promise((resolve) => {
      observeSqliteMutationWorkerEnd(transport, (ending) => {
        this.taskCustodyReleased =
          ending.kind === "task-complete" ||
          (ending.kind === "task-failed" && ending.custodyReleased);
        // A healthy task can consume custody before a later failed termination. Its lease
        // is already gone; only unconsumed failures need the pool's native-exit receipt.
        this.nativeExitProven =
          ending.kind === "native-exit" ||
          (ending.kind === "task-failed" &&
            ending.custodyReleased &&
            !this.healthyCloseAcknowledged);
        if (ending.kind === "task-failed") {
          this.failure ??= ending.error;
        } else if (
          (ending.kind === "native-exit" && ending.code !== 0) ||
          !this.revoked ||
          !this.cleanup ||
          (ending.kind === "task-complete" && !this.cleanup.settled)
        ) {
          this.failure ??= new Error(
            "SQLite reclamation Worker ended without confirmed cleanup; operation outcome is uncertain",
          );
        }
        resolve();
      });
    });
    // Only ordinary retained Workers use pressure retirement; validation scopes own their close.
    if (this.onRetired) {
      channel("openclaw.memory.critical").subscribe(this.onMemoryPressure);
    }
    return transport;
  }

  private observeCheckpoint(
    message: Extract<SqliteReclamationWorkerMessage, { type: "checkpoint" }>,
  ): void {
    if (
      this.retired ||
      this.failure ||
      !this.lease ||
      message.operationId !== this.operationId ||
      (this.revoked && !this.closeRequested)
    ) {
      return;
    }
    try {
      this.stateContext.admission.assertCurrent();
      this.assertPathCurrent();
      // Native close keeps its admitted custody after new requests are revoked.
      publishSqliteWalCheckpointObservation(this.options.path, message.snapshot);
    } catch {
      // A retired state owner cannot publish late diagnostics or change native settlement.
    }
  }

  private requestTermination(transport: SqliteMutationWorkerTransport): void {
    void terminateSqliteMutationWorker(transport).catch((error: unknown) => {
      this.failure = new AggregateError(
        [this.failure, error].filter((failure) => failure !== undefined),
        "SQLite reclamation Worker termination failed",
        { cause: error },
      );
    });
  }

  private revoke(): void {
    this.revoked = true;
    if (this.commitGate) {
      revokeSqliteReclamationCommit(this.commitGate);
    }
    clearTimeout(this.idle);
  }

  async close(): Promise<void> {
    this.revoke();
    if (this.retired) {
      return;
    }
    if (this.execution?.failure) {
      await this.execution.retryFailedRetirements();
      if (this.retired) {
        return;
      }
    }
    return (this.closing ??= (async () => {
      await this.active?.catch(() => {});
      const transport = this.transport;
      if (transport) {
        const worker = transport.channel;
        worker.ref();
        await runOpenClawAgentWorkerWrite(this.options, async () => {
          const operationId = ++this.operationId;
          await withSqliteMutationWorkerCoordination(
            {
              ...this.stateContext,
              coordinatorRuntime: { ...this.stateContext.coordinatorRuntime, keepAlive: false },
            },
            transport,
            operationId,
            async (coordination) => {
              try {
                this.closeRequested = true;
                worker.postMessage(
                  {
                    type: "close",
                    operationId,
                    coordination,
                  } satisfies SqliteReclamationWorkerCloseRequest,
                  coordination.stateLifecycle ? [coordination.stateLifecycle] : [],
                );
              } catch (error) {
                await terminateSqliteMutationWorker(transport);
                throw error;
              } finally {
                // Checkpoint and native close retain admission even if dispatch fails.
                await (transport.kind === "pooled"
                  ? Promise.race([this.closed.promise, this.ended])
                  : this.ended);
              }
            },
          );
          if (transport.kind === "pooled") {
            // The task cannot yield its slot until the parent's close delegate has released.
            try {
              worker.postMessage({ type: "release", operationId }, []);
            } catch (error) {
              await terminateSqliteMutationWorker(transport);
              throw error;
            } finally {
              await this.ended;
            }
          }
        });
      }
      if (transport?.kind === "pooled" && transport.custodyReleased()) {
        // A later pool close can settle a previously failed retirement before this owner retries.
        this.taskCustodyReleased = true;
        this.nativeExitProven ||= !this.healthyCloseAcknowledged;
      }
      // A settled close released the lease even when the request failed.
      // Only unsettled cleanup needs the parent's exact receipt after native exit.
      if (this.lease && this.nativeExitProven && !this.cleanup?.settled) {
        const lease = this.lease;
        await cleanupRetiredAgentDatabaseLease({
          context: this.stateContext,
          stopped: this.ended!,
          lease,
          assertOwned: () => {
            if (
              !this.revoked ||
              this.retired ||
              !this.nativeExitProven ||
              this.transport !== transport ||
              this.lease !== lease
            ) {
              throw new Error("SQLite reclamation Worker no longer owns its retired lease");
            }
          },
        });
      } else if (
        transport &&
        (!this.cleanup?.settled || (transport.kind === "pooled" && !this.taskCustodyReleased))
      ) {
        throw new Error(
          "SQLite reclamation Worker cleanup is uncertain; restart OpenClaw before deleting the owning agent",
        );
      }
      if (this.cleanup?.cleanupWarnings.length) {
        log.warn("SQLite session reclamation Worker recovered cleanup failures", {
          errors: this.cleanup.cleanupWarnings,
          path: this.options.path,
        });
      }
      this.retired = true;
      channel("openclaw.memory.critical").unsubscribe(this.onMemoryPressure);
      this.unregisterAgent();
      this.unregisterState();
      process.off("beforeExit", this.beforeExit);
      this.transport?.channel.removeAllListeners();
      if (this.transport?.kind === "pooled") {
        this.transport.channel.close();
      }
      this.onRetired?.(this);
    })().finally(() => {
      this.closing = undefined;
    }));
  }
}
