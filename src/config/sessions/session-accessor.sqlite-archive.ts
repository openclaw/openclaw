import path from "node:path";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId, Worker } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runScopedSqliteArchiveOperation } from "./session-accessor.sqlite-archive-session.js";
import type {
  MaterializedSessionStateDeletePlan,
  SessionStateDeletePlan,
  TranscriptArchivePublishPlan,
  TranscriptArchivePublishResult,
  TranscriptArchiveReadPlan,
  TranscriptArchiveReadResult,
  TranscriptArchiveWorkerPlan,
  TranscriptArchiveWorkerResult,
} from "./session-accessor.sqlite-archive-types.js";
import type { SqliteSessionReclamationDiagnostics } from "./session-accessor.sqlite-contract.js";
import {
  readSessionStateDeleteSnapshot,
  sqliteSessionStateDeleteSnapshotsEqual,
} from "./session-accessor.sqlite-delete-snapshot.js";
import { withSqliteMutationWorkerCoordination } from "./session-accessor.sqlite-worker-coordination.js";
import {
  runSqliteMutationWorkerRequest,
  type SqliteMutationWorkerValidationOwner,
  type SqliteWorkerWriteAdmission,
} from "./session-accessor.sqlite-worker-request.js";
import type { SessionColdWorkerData } from "./session-cold-storage-worker.js";

function resolveSourceWorkerExecArgv(): string[] {
  // Node 22 can strip the .ts entrypoint itself, but `--import tsx` does not
  // register tsx's ESM resolver inside a Worker. Explicitly register the
  // supported programmatic API so source-tree .js specifiers map back to .ts.
  // Built .js workers do not use this development/test-only preload.
  const tsxApiUrl = import.meta.resolve("tsx/esm/api");
  const registerTsx = `import { register } from ${JSON.stringify(tsxApiUrl)}; register();`;
  return ["--import", `data:text/javascript,${encodeURIComponent(registerTsx)}`];
}

export function createSqliteTranscriptArchiveWorker(workerData: object): Worker {
  const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscriptArchive);
  return new Worker(workerUrl, {
    workerData,
    execArgv: workerUrl.pathname.endsWith(".ts") ? resolveSourceWorkerExecArgv() : undefined,
  });
}

type TranscriptArchiveWorkerOperation<Result> =
  | { expectedMessageType: "done" | "published"; workerData: object }
  | {
      expectedMessageType: "reclaimed";
      workerData: SessionColdWorkerData;
      diagnostics?: SqliteSessionReclamationDiagnostics;
      onCommitRequest: () => void;
      withWriteAdmission: SqliteWorkerWriteAdmission<Result>;
      validationOwner?: SqliteMutationWorkerValidationOwner;
    };

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
      worker,
      0,
      (coordination) =>
        runSqliteMutationWorkerRequest<Result>({
          worker,
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

export function runExclusiveSqliteTranscriptArchiveWorker<T>(run: () => Promise<T>): Promise<T> {
  return sqliteTranscriptArchiveWorkerQueue.enqueue(
    SQLITE_TRANSCRIPT_ARCHIVE_WORKER_QUEUE_KEY,
    run,
  );
}

export function runSqliteTranscriptArchiveWorkerOperation<Result>(
  params: TranscriptArchiveWorkerOperation<Result>,
): Promise<Result[]> {
  return runExclusiveSqliteTranscriptArchiveWorker(() =>
    spawnSqliteTranscriptArchiveWorkerOperation<Result>(params),
  );
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
): Promise<TranscriptArchivePublishResult[]> {
  const scoped = runScopedSqliteArchiveOperation(
    { operation: "publish", plans },
    createSqliteTranscriptArchiveWorker,
    runExclusiveSqliteTranscriptArchiveWorker,
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
    expectedMessageType: "published",
    workerData: { operation: "publish", type: "sqlite-transcript-archive-v2", plans },
  });
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

function validateEmptyTranscriptArchivePlan(plan: TranscriptArchiveWorkerPlan): void {
  const opened = withOpenClawAgentDatabaseReadOnly(
    (database) => readSessionStateDeleteSnapshot(database.db, plan.sessionId),
    { agentId: plan.agentId, path: plan.databasePath },
  );
  if (!opened.found) {
    throw new Error(
      `Cannot archive SQLite transcript ${plan.sessionId}: ${opened.reason.replaceAll("-", " ")}`,
    );
  }
  if (!sqliteSessionStateDeleteSnapshotsEqual(opened.value, plan.snapshot)) {
    throw new Error(
      `SQLite session state changed before archive materialization for ${plan.sessionId}`,
    );
  }
}

// Reads and encodes one consistent generation outside SQLite write transactions
// and off the gateway event loop. The lifecycle Worker queue and per-call
// dedupe prevent concurrent whole-buffer spikes within this path.
export async function materializeSessionStateDeletePlans(
  plans: readonly SessionStateDeletePlan[],
): Promise<MaterializedSessionStateDeletePlan[]> {
  const deduped = dedupeSqliteSessionStateDeletePlans(plans);
  const workerResults: TranscriptArchiveWorkerResult[] = [];
  const workerPlans: TranscriptArchiveWorkerPlan[] = [];
  for (const archivePlan of deduped.filter((plan) => plan.archiveTranscript)) {
    if (archivePlan.snapshot.lastSeq === null) {
      // Empty transcripts still need a fresh snapshot fence, but have no bytes
      // to encode off-thread and should not pay Worker startup latency.
      validateEmptyTranscriptArchivePlan(archivePlan);
      workerResults.push({ archive: null, sessionId: archivePlan.sessionId });
      continue;
    }
    workerPlans.push(archivePlan);
  }
  if (workerPlans.length > 0) {
    workerResults.push(...(await runSqliteTranscriptArchiveWorker(workerPlans)));
  }
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
