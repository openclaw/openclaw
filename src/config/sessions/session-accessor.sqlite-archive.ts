import path from "node:path";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId, type Worker } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerThreadExecArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { createCpuTrackedWorker } from "../../infra/worker-cpu.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runScopedSqliteArchiveOperation } from "./session-accessor.sqlite-archive-session.js";
import type {
  MaterializedSessionStateDeletePlan,
  SessionStateDeletePlan,
  TranscriptArchivePagePlan,
  TranscriptArchivePageResult,
  TranscriptArchivePublishPlan,
  TranscriptArchivePublishResult,
  TranscriptArchiveReadPlan,
  TranscriptArchiveReadResult,
  TranscriptArchiveWorkerPlan,
  TranscriptArchiveWorkerResult,
} from "./session-accessor.sqlite-archive-types.js";
import type { SqliteSessionReclamationDiagnostics } from "./session-accessor.sqlite-contract.js";
import { sqliteSessionStateDeleteSnapshotsEqual } from "./session-accessor.sqlite-delete-snapshot.js";
import { withSqliteMutationWorkerCoordination } from "./session-accessor.sqlite-worker-coordination.js";
import {
  runSqliteMutationWorkerRequest,
  type SqliteMutationWorkerValidationOwner,
  type SqliteWorkerWriteAdmission,
} from "./session-accessor.sqlite-worker-request.js";
import type { SessionColdWorkerData } from "./session-cold-storage-worker.js";

export function createSqliteTranscriptArchiveWorker(workerData: object): Worker {
  const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscriptArchive);
  return createCpuTrackedWorker(workerUrl, {
    resourceLimits: { maxOldGenerationSizeMb: 512 },
    workerData,
    execArgv: resolveRuntimeWorkerThreadExecArgv(workerUrl),
  });
}

type TranscriptArchiveWorkerOperation<Result> = {
  assertCurrent?: () => void;
  signal?: AbortSignal;
} & (
  | { expectedMessageType: "done" | "published" | "sized"; workerData: object }
  | {
      expectedMessageType: "reclaimed";
      workerData: SessionColdWorkerData;
      diagnostics?: SqliteSessionReclamationDiagnostics;
      onCommitRequest: () => void;
      withWriteAdmission: SqliteWorkerWriteAdmission<Result>;
      validationOwner?: SqliteMutationWorkerValidationOwner;
    }
);

function spawnSqliteTranscriptArchiveWorkerOperation<Result>(
  input: TranscriptArchiveWorkerOperation<Result>,
): Promise<Result[]> {
  const params =
    input.expectedMessageType === "reclaimed"
      ? {
          ...input,
          stateContext: captureOpenClawStateWorkerContext({
            env: input.workerData.plan.databaseOptions.env,
          }),
        }
      : input;
  let worker: Worker;
  try {
    worker = createSqliteTranscriptArchiveWorker(params.workerData);
  } catch (error) {
    return Promise.reject(toStringifiedError(error));
  }

  if (params.expectedMessageType === "reclaimed") {
    const startedAt = performance.now();
    const workerThreadId = worker.threadId;
    let exitCode: number | undefined;
    if (params.diagnostics) {
      params.diagnostics.workerThreadId = workerThreadId;
    }
    // Cold mutations retain their one-shot cleanup/exit lifetime, never a sweep connection.
    const operation = withSqliteMutationWorkerCoordination(
      params.stateContext,
      { kind: "dedicated", channel: worker },
      0,
      (coordination) =>
        runSqliteMutationWorkerRequest<Result>({
          transport: { kind: "dedicated", channel: worker },
          operationId: 0,
          completion: "exit",
          onCommitRequest: params.onCommitRequest,
          withWriteAdmission: params.withWriteAdmission,
          validationOwner: params.validationOwner,
          onExit: (code) => {
            exitCode = code;
          },
          dispatch: () =>
            worker.postMessage(
              { type: "mutate", coordination },
              coordination.stateLifecycle ? [coordination.stateLifecycle] : [],
            ),
        }),
    ).then((result) => [result]);
    const observe = (outcome: "resolved" | "rejected") => {
      const elapsedMs = Math.round(performance.now() - startedAt);
      if (elapsedMs >= 1_000) {
        createSubsystemLogger("session-sqlite").warn("slow SQLite reclamation Worker operation", {
          pid: process.pid,
          threadId,
          isMainThread,
          workerThreadId,
          reclamationKind: params.diagnostics?.kind ?? params.workerData.plan.kind,
          elapsedMs,
          outcome,
          exitCode,
        });
      }
    };
    void operation
      .then(
        () => observe("resolved"),
        () => observe("rejected"),
      )
      .catch(() => {});
    return operation;
  }

  return new Promise((resolve, reject) => {
    let results: Result[] | undefined;
    let workerError: Error | undefined;
    worker.on("message", (message: { results: Result[]; type: string }) => {
      if (message.type === params.expectedMessageType) {
        (results ??= []).push(...message.results);
      }
    });
    worker.once("error", (error) => {
      // An uncaught Worker error is followed by exit. Wait for that event so
      // callers never race the Worker's SQLite/file handles on Windows.
      workerError ??= toStringifiedError(error);
    });
    worker.once("exit", (code) => {
      worker.removeAllListeners();
      if (workerError) {
        reject(workerError);
        return;
      }
      if (code !== 0) {
        reject(new Error(`SQLite transcript archive worker exited with code ${code}`));
        return;
      }
      if (!results) {
        reject(new Error("SQLite transcript archive worker exited without results"));
        return;
      }
      resolve(results);
    });
  });
}

// Serialize lifecycle archive Workers so this path cannot multiply
// whole-buffer usage across several Worker heaps at once.
const sqliteTranscriptArchiveWorkerQueue = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteTranscriptArchiveWorkerQueue"),
  () => new KeyedAsyncQueue(),
);
const SQLITE_TRANSCRIPT_ARCHIVE_WORKER_QUEUE_KEY = "lifecycle-archive";

export function runExclusiveSqliteTranscriptArchiveWorker<T>(
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) {
    return sqliteTranscriptArchiveWorkerQueue.enqueue(
      SQLITE_TRANSCRIPT_ARCHIVE_WORKER_QUEUE_KEY,
      run,
    );
  }
  return new Promise<T>((resolve, reject) => {
    let pending: (() => Promise<T>) | undefined = run;
    const cancel = () => {
      // Drop execution before releasing the caller's claim; its FIFO slot remains inert.
      pending = undefined;
      reject(toStringifiedError(signal.reason));
    };
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    void sqliteTranscriptArchiveWorkerQueue
      .enqueue(SQLITE_TRANSCRIPT_ARCHIVE_WORKER_QUEUE_KEY, () => {
        signal.removeEventListener("abort", cancel);
        const admitted = pending;
        pending = undefined;
        if (!admitted) {
          throw toStringifiedError(signal.reason);
        }
        // Once admitted, even a revoked request must join its physical settlement.
        return admitted();
      })
      .then(resolve, reject);
  });
}

export function runSqliteTranscriptArchiveWorkerOperation<Result>(
  params: TranscriptArchiveWorkerOperation<Result>,
): Promise<Result[]> {
  return runExclusiveSqliteTranscriptArchiveWorker(() => {
    params.assertCurrent?.();
    return spawnSqliteTranscriptArchiveWorkerOperation<Result>(params);
  }, params.signal);
}

function runSqliteTranscriptArchiveWorker(
  plans: readonly TranscriptArchiveWorkerPlan[],
): Promise<TranscriptArchiveWorkerResult[]> {
  const scoped = runScopedSqliteArchiveOperation(
    { operation: "materialize", plans },
    createSqliteTranscriptArchiveWorker,
    runExclusiveSqliteTranscriptArchiveWorker,
  );
  if (scoped) {
    return scoped.then((result) => {
      if (result.type !== "done") {
        throw new Error("SQLite archive Worker returned another operation's result");
      }
      return result.results;
    });
  }
  return runSqliteTranscriptArchiveWorkerOperation<TranscriptArchiveWorkerResult>({
    expectedMessageType: "done",
    workerData: { operation: "materialize", type: "sqlite-transcript-archive-v2", plans },
  });
}

export function runSqliteTranscriptArchivePublishWorker(
  plans: readonly TranscriptArchivePublishPlan[],
  signal?: AbortSignal,
): Promise<TranscriptArchivePublishResult[]> {
  const scoped = runScopedSqliteArchiveOperation(
    { operation: "publish", plans },
    createSqliteTranscriptArchiveWorker,
    (run) => runExclusiveSqliteTranscriptArchiveWorker(run, signal),
  );
  if (scoped) {
    return scoped.then((result) => {
      if (result.type !== "published") {
        throw new Error("SQLite archive Worker returned another operation's result");
      }
      return result.results;
    });
  }
  return runSqliteTranscriptArchiveWorkerOperation<TranscriptArchivePublishResult>({
    signal,
    expectedMessageType: "published",
    workerData: { operation: "publish", type: "sqlite-transcript-archive-v2", plans },
  });
}

/** Probe pending publication without creating a writable database or archive schema. */
export async function readPendingSqliteTranscriptArchivesInWorker(
  plan: {
    agentId: string;
    databasePath: string;
    env: NodeJS.ProcessEnv;
  },
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const { withSessionHistoryWorkerDatabase } =
    await import("./session-transcript-worker-runtime.js");
  signal.throwIfAborted();
  return withSessionHistoryWorkerDatabase(
    { agentId: plan.agentId, path: plan.databasePath, env: plan.env },
    (reader) => reader.readPendingArchives({ env: plan.env }, signal),
  );
}

export async function runSqliteTranscriptArchiveReadWorker(
  plans: readonly TranscriptArchiveReadPlan[],
): Promise<TranscriptArchiveReadResult[]> {
  const scoped = runScopedSqliteArchiveOperation(
    { operation: "read-final", plans },
    createSqliteTranscriptArchiveWorker,
    runExclusiveSqliteTranscriptArchiveWorker,
  );
  if (!scoped) {
    throw new Error("SQLite archive reads require their captured database scope");
  }
  const result = await scoped;
  if (result.type !== "final-read") {
    throw new Error("SQLite archive Worker returned another operation's result");
  }
  return result.results;
}

export async function runSqliteTranscriptArchivePageWorker(
  plans: readonly TranscriptArchivePagePlan[],
): Promise<Array<TranscriptArchivePageResult | undefined>> {
  const scoped = runScopedSqliteArchiveOperation(
    { operation: "read-page", plans },
    createSqliteTranscriptArchiveWorker,
    runExclusiveSqliteTranscriptArchiveWorker,
  );
  if (!scoped) {
    throw new Error("SQLite archive reads require their captured database scope");
  }
  const result = await scoped;
  if (result.type !== "page-read") {
    throw new Error("SQLite archive Worker returned another operation's result");
  }
  return result.results;
}

// Reads and encodes one consistent generation outside SQLite write transactions
// and off the gateway event loop. The lifecycle Worker queue and per-call
// dedupe prevent concurrent whole-buffer spikes within this path.
export async function materializeSessionStateDeletePlans(
  plans: readonly SessionStateDeletePlan[],
): Promise<MaterializedSessionStateDeletePlan[]> {
  const deduped = dedupeSqliteSessionStateDeletePlans(plans);
  const workerPlans = deduped.filter((plan) => plan.archiveTranscript);
  const workerResults =
    workerPlans.length > 0 ? await runSqliteTranscriptArchiveWorker(workerPlans) : [];
  const resultBySessionId = new Map(workerResults.map((result) => [result.sessionId, result]));

  return deduped.map((plan) => {
    if (!plan.archiveTranscript) {
      return Object.assign({}, plan, { archive: null, archivedTranscript: null });
    }
    const result = resultBySessionId.get(plan.sessionId);
    if (!result) {
      throw new Error(`SQLite transcript archive worker omitted ${plan.sessionId}`);
    }
    const generation = plan.snapshot.generation;
    if (result.archive && !generation) {
      throw new Error(
        `Cannot archive SQLite transcript without a generation for ${plan.sessionId}`,
      );
    }
    const archivedTranscript =
      result.archive && generation
        ? {
            generation,
            sessionId: plan.sessionId,
            archivedPath: path.join(plan.archiveDirectory, result.archive.archiveName),
            sourcePath: path.join(plan.archiveDirectory, `${plan.sessionId}.jsonl`),
          }
        : null;
    return Object.assign({}, plan, { archive: result.archive, archivedTranscript });
  });
}

// Multiple removed entries can point at one transcript session. If any owner
// asked to keep an archive, the shared row gets exported once.
function dedupeSqliteSessionStateDeletePlans(
  plans: readonly SessionStateDeletePlan[],
): SessionStateDeletePlan[] {
  const deduped = new Map<string, SessionStateDeletePlan>();
  for (const plan of plans) {
    const existing = deduped.get(plan.sessionId);
    if (!existing) {
      deduped.set(plan.sessionId, plan);
      continue;
    }
    if (
      existing.agentId !== plan.agentId ||
      existing.archiveDirectory !== plan.archiveDirectory ||
      existing.databasePath !== plan.databasePath ||
      existing.reason !== plan.reason ||
      !sqliteSessionStateDeleteSnapshotsEqual(existing.snapshot, plan.snapshot)
    ) {
      throw new Error(`Conflicting SQLite transcript archive plans for ${plan.sessionId}`);
    }
    if (!existing.archiveTranscript && plan.archiveTranscript) {
      deduped.set(plan.sessionId, { ...existing, archiveTranscript: true });
    }
  }
  return [...deduped.values()];
}
