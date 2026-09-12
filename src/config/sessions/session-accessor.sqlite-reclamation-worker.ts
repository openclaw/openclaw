import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { isMainThread, threadId, type Worker } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { OpenClawAgentDatabaseClaim } from "../../state/openclaw-agent-db-identity.js";
import {
  createSqliteTranscriptArchiveWorker,
  runExclusiveSqliteTranscriptArchiveWorker,
} from "./session-accessor.sqlite-archive.js";
import type {
  SqliteSessionReclamationAdmissionDiagnostics,
  SqliteSessionReclamationDiagnostics,
} from "./session-accessor.sqlite-contract.js";
import type {
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  runSqliteMutationWorkerRequest,
  type SqliteMutationWorkerMessage,
} from "./session-accessor.sqlite-worker-request.js";

type DatabaseOptions = SqliteSessionReclamationPlan["databaseOptions"];
export type SqliteReclamationWorkerRequest = {
  type: "reclaim";
  operationId: number;
  commitGate: SharedArrayBuffer;
  plan: SqliteSessionReclamationPlan;
};
type WorkerCleanup = { cleanupWarnings: string[]; settled: boolean };
export type SqliteReclamationWorkerMessage =
  | SqliteMutationWorkerMessage<SqliteSessionReclamationResult>
  | ({ type: "closed" } & WorkerCleanup);

const log = createSubsystemLogger("session-sqlite");
const SLOW_RECLAMATION_WORKER_MS = 1_000;

/** One lazy Worker per pressure sweep; claims and write admission remain per request. */
export class SqliteReclamationWorker {
  private owner?: { options: DatabaseOptions; identity: OpenClawAgentDatabaseClaim["identity"] };
  private worker?: Worker;
  private workerThreadId?: number;
  private exited?: Promise<void>;
  private failure?: Error;
  private reportedFailure?: Error;
  private cleanup?: WorkerCleanup;
  private closing?: Promise<void>;
  private operationId = 0;

  assertCurrent(options: DatabaseOptions, claim: OpenClawAgentDatabaseClaim): void {
    claim.assertCurrent();
    if (this.failure) {
      this.reportedFailure = this.failure;
      throw this.failure;
    }
    if (this.closing) {
      throw new Error("SQLite session reclamation scope is closed");
    }
    if (
      this.owner &&
      (!isDeepStrictEqual(this.owner.options, options) || this.owner.identity !== claim.identity)
    ) {
      throw new Error("SQLite session reclamation database owner is no longer current");
    }
  }

  run(params: {
    claim: OpenClawAgentDatabaseClaim;
    diagnostics?: SqliteSessionReclamationDiagnostics;
    plan: SqliteSessionReclamationPlan;
    commitGate: SharedArrayBuffer;
    onCommitRequest: () => unknown[];
    withWriteAdmission: (
      run: (refusal?: { error: unknown }) => Promise<SqliteSessionReclamationResult | undefined>,
      diagnostics: SqliteSessionReclamationAdmissionDiagnostics,
    ) => Promise<void>;
    transferList: ArrayBuffer[];
  }): Promise<SqliteSessionReclamationResult> {
    // Each queued request captures its own caller, not the first victim's context.
    return runExclusiveSqliteTranscriptArchiveWorker(async () => {
      const startedAt = performance.now();
      const options = params.plan.databaseOptions;
      this.assertCurrent(options, params.claim);
      this.owner ??= { options: structuredClone(options), identity: params.claim.identity };
      this.worker ??= this.start(options);
      const worker = this.worker;
      if (params.diagnostics) {
        params.diagnostics.workerThreadId = this.workerThreadId;
      }
      const operationId = ++this.operationId;
      let exitCode: number | undefined;
      const operation = runSqliteMutationWorkerRequest<SqliteSessionReclamationResult>({
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
              path: options.path,
            });
          }
        },
        withWriteAdmission: params.withWriteAdmission,
        dispatch: () =>
          worker.postMessage(
            {
              type: "reclaim",
              operationId,
              commitGate: params.commitGate,
              plan: params.plan,
            } satisfies SqliteReclamationWorkerRequest,
            params.transferList,
          ),
      }).catch((error: unknown) => {
        this.failure = toStringifiedError(error);
        this.reportedFailure = this.failure;
        throw this.failure;
      });
      const observeCompletion = (outcome: "resolved" | "rejected") => {
        const elapsedMs = Math.round(performance.now() - startedAt);
        if (elapsedMs >= SLOW_RECLAMATION_WORKER_MS) {
          log.warn("slow SQLite reclamation Worker operation", {
            pid: process.pid,
            threadId,
            isMainThread,
            reclamationKind: params.diagnostics?.kind ?? params.plan.kind,
            workerThreadId: this.workerThreadId,
            elapsedMs,
            outcome,
            exitCode,
          });
        }
      };
      // Diagnostics retain this request's trace context and cannot change its result.
      void operation
        .then(
          () => observeCompletion("resolved"),
          () => observeCompletion("rejected"),
        )
        .catch(() => {});
      return await operation;
    });
  }

  private start(databaseOptions: DatabaseOptions): Worker {
    const worker = createSqliteTranscriptArchiveWorker({
      type: "sqlite-transcript-archive-v2",
      operation: "reclaim",
      databaseOptions,
    });
    this.workerThreadId = worker.threadId;
    worker.on("message", (message: SqliteReclamationWorkerMessage) => {
      if (message.type === "closed") {
        this.cleanup = message;
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
        if (code !== 0 || !this.closing || !this.cleanup) {
          this.failure ??= new Error(
            `SQLite session reclamation Worker exited with code ${code} without completing its lifetime; outcome is uncertain, restart OpenClaw before deleting the owning agent`,
          );
        }
        resolve();
      });
    });
    return worker;
  }

  close(): Promise<void> {
    if (!this.owner) {
      // A never-started scope has nothing to join and must not wait on another owner's work.
      return (this.closing ??= Promise.resolve());
    }
    // Revoke now, join behind admitted requests, then release the sweep's maintenance lane.
    return (this.closing ??= runExclusiveSqliteTranscriptArchiveWorker(async () => {
      this.worker?.postMessage({ type: "close" });
      await this.exited;
      if (this.failure && this.failure !== this.reportedFailure) {
        throw this.failure;
      }
      if (this.cleanup && !this.cleanup.settled) {
        log.error("SQLite session reclamation committed but Worker cleanup is incomplete", {
          errors: this.cleanup.cleanupWarnings,
          path: this.owner?.options.path,
          recovery: "restart OpenClaw before deleting the owning agent",
        });
      } else if (this.cleanup?.cleanupWarnings.length) {
        log.warn("SQLite session reclamation Worker recovered cleanup failures", {
          errors: this.cleanup.cleanupWarnings,
          path: this.owner?.options.path,
        });
      }
    }));
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
