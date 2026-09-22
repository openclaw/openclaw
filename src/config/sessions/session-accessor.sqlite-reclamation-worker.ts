import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { isMainThread, threadId, type Worker } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { captureStateDatabaseCoordinatorRuntime } from "../../infra/state-database-coordinator.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { OpenClawAgentDatabaseClaim } from "../../state/openclaw-agent-db-identity.js";
import {
  releaseExitedOpenClawAgentDatabaseWorkerLease,
  type OpenClawAgentDatabaseWorkerLeaseReceipt,
} from "../../state/openclaw-agent-db-lease.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-lifecycle.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  createSqliteTranscriptArchiveWorker,
  runExclusiveSqliteTranscriptArchiveWorker,
} from "./session-accessor.sqlite-archive.js";
import type {
  CanonicalSessionValidationResult,
  SqliteSessionReclamationDiagnostics,
} from "./session-accessor.sqlite-contract.js";
import type {
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { revokeSqliteReclamationCommit } from "./session-accessor.sqlite-reclamation-commit.js";
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

type DatabaseOptions = SqliteSessionReclamationPlan["databaseOptions"];
export type SqliteReclamationWorkerRequest = {
  type: "reclaim";
  operationId: number;
  commitGate: SharedArrayBuffer;
  plan: SqliteSessionReclamationPlan;
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
  onCommitRequest: () => unknown[];
  withWriteAdmission: SqliteWorkerWriteAdmission<Result>;
};
type WorkerCleanup = { cleanupWarnings: string[]; settled: boolean };
export type SqliteReclamationWorkerMessage =
  | SqliteMutationWorkerMessage<SqliteSessionReclamationResult>
  | { type: "lease"; receipt: OpenClawAgentDatabaseWorkerLeaseReceipt }
  | ({ type: "closed" } & WorkerCleanup);

const log = createSubsystemLogger("session-sqlite");
const SLOW_RECLAMATION_WORKER_MS = 1_000;
const RECLAMATION_WORKER_IDLE_MS = 60_000;
type ReclamationWorkerSlot = { worker?: SqliteReclamationWorker };
const retained = resolveGlobalSingleton<ReclamationWorkerSlot>(
  Symbol.for("openclaw.sessionReclamationWorker"),
  () => ({}),
);

/** The global archive FIFO bounds ordinary reclamation's whole-buffer heaps. */
export function withSqliteReclamationWorker<T>(
  options: DatabaseOptions,
  claim: OpenClawAgentDatabaseClaim,
  run: (worker: SqliteReclamationWorker) => Promise<T>,
  assertRequestCurrent: () => void,
): Promise<T> {
  return runExclusiveSqliteTranscriptArchiveWorker(() =>
    useReclamationWorker(retained, options, claim, run, assertRequestCurrent),
  );
}

/** Startup bounds these scopes; each keeps one worker through certification and native close. */
export async function withSqliteCanonicalValidationWorker<T>(
  run: (withWorker: typeof withSqliteReclamationWorker) => Promise<T>,
): Promise<T> {
  const slot: ReclamationWorkerSlot = {};
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
  const worker = (slot.worker ??= new SqliteReclamationWorker(options, claim.identity));
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
class SqliteReclamationWorker {
  private worker?: Worker;
  private workerThreadId?: number;
  private exited?: Promise<void>;
  private failure?: Error;
  private cleanup?: WorkerCleanup;
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

  constructor(
    private readonly options: DatabaseOptions,
    private readonly identity: OpenClawAgentDatabaseClaim["identity"],
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
    process.on("beforeExit", this.beforeExit);
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
    const file = statSync(this.options.path, { bigint: true });
    if (`${file.dev}:${file.ino}` !== this.identity) {
      throw new Error("SQLite session reclamation database path was replaced");
    }
  }

  async use<T>(run: () => Promise<T>): Promise<T> {
    clearTimeout(this.idle);
    this.worker?.ref();
    const operation = Promise.resolve().then(run);
    this.active = operation;
    try {
      return await operation;
    } finally {
      this.active = undefined;
      if (!this.revoked) {
        this.worker?.unref();
        this.idle = setTimeout(this.beforeExit, RECLAMATION_WORKER_IDLE_MS);
        this.idle.unref();
      }
    }
  }

  run(
    params: MutationRunParams<SqliteSessionReclamationResult> & {
      plan: SqliteSessionReclamationPlan;
      transferList: ArrayBuffer[];
    },
  ): Promise<SqliteSessionReclamationResult> {
    return this.runRequest({
      ...params,
      databaseOptions: params.plan.databaseOptions,
      kind: params.plan.kind,
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

  private runRequest<Result>(
    params: MutationRunParams<Result> & {
      databaseOptions: DatabaseOptions;
      kind: string;
      request: (
        operationId: number,
        coordination: SqliteMutationWorkerCoordination,
      ) => SqliteMutationWorkerRequest;
      transferList: ArrayBuffer[];
    },
  ): Promise<Result> {
    const startedAt = performance.now();
    this.assertCurrent(params.databaseOptions, params.claim);
    this.worker ??= this.start();
    const worker = this.worker;
    if (params.diagnostics) {
      params.diagnostics.workerThreadId = this.workerThreadId;
    }
    const operationId = ++this.operationId;
    this.commitGate = params.commitGate;
    let exitCode: number | undefined;
    const operation = withSqliteMutationWorkerCoordination(
      this.stateContext,
      worker,
      operationId,
      (coordination) =>
        runSqliteMutationWorkerRequest<Result>({
          worker,
          operationId,
          completion: "result",
          getFailure: () => this.failure,
          onExit: (code) => {
            exitCode = code;
          },
          onCommitRequest: () => {
            const errors = params.onCommitRequest();
            if (errors.length) {
              log.warn("SQLite session reclamation recovered commit settlement errors", {
                errors: errors.map(String),
                path: this.options.path,
              });
            }
          },
          withWriteAdmission: params.withWriteAdmission,
          validationOwner: params.validationOwner,
          dispatch: () =>
            worker.postMessage(params.request(operationId, coordination), [
              ...params.transferList,
              ...(coordination.stateLifecycle ? [coordination.stateLifecycle] : []),
            ]),
        }),
    );
    const observeCompletion = (outcome: "resolved" | "rejected") => {
      const elapsedMs = Math.round(performance.now() - startedAt);
      if (elapsedMs >= SLOW_RECLAMATION_WORKER_MS) {
        log.warn("slow SQLite reclamation Worker operation", {
          pid: process.pid,
          threadId,
          isMainThread,
          reclamationKind: params.diagnostics?.kind ?? params.kind,
          workerThreadId: this.workerThreadId,
          elapsedMs,
          outcome,
          exitCode,
        });
      }
    };
    void operation
      .then(
        () => observeCompletion("resolved"),
        () => observeCompletion("rejected"),
      )
      .catch(() => {});
    return operation.finally(() => {
      this.commitGate = undefined;
    });
  }

  private start(): Worker {
    const worker = createSqliteTranscriptArchiveWorker({
      type: "sqlite-transcript-archive-v2",
      operation: "reclaim",
      databaseOptions: this.options,
    });
    this.workerThreadId = worker.threadId;
    worker.on("message", (message: SqliteReclamationWorkerMessage) => {
      if (message.type === "closed") {
        this.cleanup = message;
      } else if (message.type === "lease") {
        if (
          message.receipt.agentId !== this.options.agentId ||
          message.receipt.path !== this.options.path ||
          message.receipt.ownerPid !== process.pid ||
          message.receipt.sharedStateIdentity !== this.stateContext.admission.identity.key ||
          (this.lease && !isDeepStrictEqual(this.lease, message.receipt))
        ) {
          this.failure = new Error("SQLite reclamation Worker changed its lease receipt");
          void worker.terminate();
        } else {
          this.lease = message.receipt;
        }
      }
    });
    worker.once("error", (error) => {
      this.failure ??= toStringifiedError(error);
    });
    worker.once("messageerror", (error) => {
      this.failure ??= toStringifiedError(error);
      void worker.terminate();
    });
    this.exited = new Promise((resolve) => {
      worker.once("exit", (code) => {
        if (code !== 0 || !this.revoked || !this.cleanup) {
          this.failure ??= new Error(
            `SQLite reclamation Worker exited with code ${code}; operation outcome is uncertain`,
          );
        }
        resolve();
      });
    });
    return worker;
  }

  private revoke(): void {
    this.revoked = true;
    if (this.commitGate) {
      revokeSqliteReclamationCommit(this.commitGate);
    }
    clearTimeout(this.idle);
  }

  close(): Promise<void> {
    this.revoke();
    if (this.retired) {
      return Promise.resolve();
    }
    return (this.closing ??= (async () => {
      await this.active?.catch(() => {});
      const worker = this.worker;
      if (worker) {
        worker.ref();
        await runOpenClawAgentWorkerWrite(this.options, async () => {
          const operationId = ++this.operationId;
          await withSqliteMutationWorkerCoordination(
            {
              ...this.stateContext,
              coordinatorRuntime: { ...this.stateContext.coordinatorRuntime, keepAlive: false },
            },
            worker,
            operationId,
            async (coordination) => {
              try {
                worker.postMessage(
                  {
                    type: "close",
                    operationId,
                    coordination,
                  } satisfies SqliteReclamationWorkerCloseRequest,
                  coordination.stateLifecycle ? [coordination.stateLifecycle] : [],
                );
              } catch (error) {
                await worker.terminate();
                throw error;
              } finally {
                // Checkpoint and native close retain admission even if dispatch fails.
                await this.exited;
              }
            },
          );
        });
      }
      // Native exit is joined before exact receipt cleanup; PID-wide cleanup is never safe.
      if (this.lease) {
        releaseExitedOpenClawAgentDatabaseWorkerLease(this.lease);
      } else if (this.worker && !this.cleanup?.settled) {
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
      this.unregisterAgent();
      this.unregisterState();
      process.off("beforeExit", this.beforeExit);
      this.worker?.removeAllListeners();
    })().finally(() => {
      this.closing = undefined;
    }));
  }
}
