import path from "node:path";
import { WorkerTaskError } from "@openclaw/worker-runtime";
import { ContextPreparationTimeoutError } from "../../agents/failover/local-preparation-error.js";
import { ensureSqliteLibrarySelected } from "../../infra/bun-sqlite-library.js";
import { getDatabaseEngineSelection } from "../../infra/database-engine/context.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { runWithSqliteDatabaseAdmissionTurn } from "../../infra/sqlite-database-admission-turn.js";
import {
  resolveWorkerPoolSize,
  SESSION_TRANSCRIPT_FOREGROUND_WORKERS,
} from "../../infra/worker-pool-sizing.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import type { WorkerTaskOptions } from "../../infra/worker-task-pool.types.js";
import type { readSessionTranscriptModelContext } from "./session-accessor.sqlite-model-context.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import type { SessionContextMessagesWorkerInput } from "./session-history-read.types.js";
import { unwrapSessionTranscriptWorkerReply } from "./session-history-worker-errors.js";
import {
  listSqliteTargetCandidatePathsForSessionStorePath,
  resolveUnsuffixedSqliteTargetFromSessionStorePath,
} from "./session-sqlite-target-paths.js";
import { resolveSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { SESSION_TRANSCRIPT_WORKER_LIMITS } from "./session-transcript-read-pools.js";
import type {
  SessionEntryWorkerInput,
  SessionEntriesWorkerInput,
  SessionEntriesWorkerResult,
  SessionResetRecallWorkerInput,
  SessionModelContextWorkerInput,
  SessionSqliteTargetWorkerInput,
} from "./session-transcript-worker-read.types.js";
import {
  acquireSessionTranscriptReadResource,
  armDatabaseWorkerIdleRetirement,
  historyClearTimeout,
  pruneHistoryDatabases,
  refreshDatabaseWorkerPressureSubscription,
  registerSessionTranscriptReaderLane,
  type HistoryDatabaseResource,
} from "./session-transcript-worker-resources.js";
import type {
  SessionTranscriptWorkerInput,
  SessionTranscriptWorkerReply,
} from "./session-transcript-worker.types.js";

export function createSessionTranscriptReadPool<Input extends SessionTranscriptWorkerInput>(
  maxWorkers: number,
  sharedCompute = false,
) {
  const lane = registerSessionTranscriptReaderLane(
    "Session transcript read",
    (onRotationComplete) =>
      new WorkerTaskPool<Input, SessionTranscriptWorkerReply<Input["kind"]>>({
        workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscript),
        prepareWorker: () => {
          // Bun loads one SQLite library per process; workers inherit the parent's selection.
          ensureSqliteLibrarySelected();
          return {
            options: { workerData: { databaseEngineSelection: getDatabaseEngineSelection() } },
          };
        },
        workerOptions: { resourceLimits: SESSION_TRANSCRIPT_WORKER_LIMITS },
        maxWorkers,
        sharedCompute,
        onRotationComplete,
      }),
  );
  return {
    async run(
      input: Input,
      options: WorkerTaskOptions<Input>,
      databases: {
        storePaths: readonly string[];
        admissionPaths: readonly string[];
        families?: readonly string[];
      },
    ) {
      // Register before admission yields; cleanup also owns reads waiting to dispatch.
      const resources = new Set<HistoryDatabaseResource>();
      historyClearTimeout(lane.idleTimer);
      lane.pending++;
      refreshDatabaseWorkerPressureSubscription();
      try {
        for (const storePath of databases.storePaths) {
          const resource = acquireSessionTranscriptReadResource(storePath);
          if (!resources.has(resource)) {
            resources.add(resource);
            resource.pending++;
          }
        }
        return await runWithSqliteDatabaseAdmissionTurn(
          databases.admissionPaths,
          () =>
            lane.pool.run(() => {
              if ([...resources].some((resource) => resource.revoked)) {
                throw new WorkerTaskError(
                  "Session transcript database read was revoked",
                  "unavailable",
                );
              }
              lane.native = true;
              for (const resource of resources) {
                resource.nativeLanes.add(lane);
              }
              return input;
            }, options),
          databases.families,
        );
      } finally {
        for (const resource of resources) {
          resource.pending--;
        }
        lane.pending--;
        pruneHistoryDatabases();
        armDatabaseWorkerIdleRetirement(lane);
      }
    },
  };
}

// Callers retain writer admission and validate snapshots before consuming parallel reads.
const modelContextReads = createSessionTranscriptReadPool<
  | SessionModelContextWorkerInput
  | SessionSqliteTargetWorkerInput
  | SessionContextMessagesWorkerInput
>(SESSION_TRANSCRIPT_FOREGROUND_WORKERS);

// Background transcript exports cannot occupy the foreground context worker.
const sessionEntries = createSessionTranscriptReadPool<
  SessionEntryWorkerInput | SessionEntriesWorkerInput | SessionResetRecallWorkerInput
>(resolveWorkerPoolSize("singleton"), true);

export async function readSessionTranscriptModelContextInWorker(
  target: SessionTranscriptRuntimeTarget,
  admission: SessionModelContextWorkerInput["admission"],
  signal?: AbortSignal,
  through?: SessionModelContextWorkerInput["through"],
  limits?: SessionModelContextWorkerInput["limits"],
  expectedIdentity?: SessionModelContextWorkerInput["expectedIdentity"],
): Promise<ReturnType<typeof readSessionTranscriptModelContext>> {
  signal?.throwIfAborted();
  const value = unwrapSessionTranscriptWorkerReply(
    await modelContextReads
      .run(
        { kind: "model-context", target, admission, through, limits, expectedIdentity },
        // Successful reads on slow hosts take 42–44s (#155627); allow startup headroom.
        { timeoutMs: 180_000, signal },
        {
          storePaths: [target.storePath],
          admissionPaths: [
            resolveUnsuffixedSqliteTargetFromSessionStorePath(target.storePath).path,
          ],
        },
      )
      .catch((error: unknown) => {
        if (error instanceof WorkerTaskError && error.code === "timeout") {
          throw new ContextPreparationTimeoutError(error);
        }
        throw error;
      }),
  );
  if (!("events" in value)) {
    throw new Error("Session context worker returned a database target instead of context");
  }
  return value;
}

export async function resolveSessionSqliteTargetInWorker(
  input: Omit<SessionSqliteTargetWorkerInput, "kind">,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(input.storePath);
  const value = unwrapSessionTranscriptWorkerReply(
    await modelContextReads.run(
      { kind: "sqlite-target", ...input },
      { inputBytes: JSON.stringify(input).length * 2, timeoutMs: 60_000, signal },
      {
        storePaths: [input.storePath],
        admissionPaths: listSqliteTargetCandidatePathsForSessionStorePath(input.storePath),
        families: target.agentId || target.shared ? [] : [path.dirname(target.path)],
      },
    ),
  );
  if (!("target" in value)) {
    throw new Error("Session context worker returned context instead of a database target");
  }
  return value.target;
}

export async function readSessionTranscriptContextMessagesInWorker(
  target: SessionTranscriptRuntimeTarget,
  admission: SessionContextMessagesWorkerInput["admission"],
  signal?: AbortSignal,
  expectedIdentity?: SessionContextMessagesWorkerInput["expectedIdentity"],
) {
  signal?.throwIfAborted();
  const value = unwrapSessionTranscriptWorkerReply(
    await modelContextReads.run(
      { kind: "context-messages", target, admission, expectedIdentity },
      { timeoutMs: 60_000, signal },
      {
        storePaths: [target.storePath],
        admissionPaths: [resolveUnsuffixedSqliteTargetFromSessionStorePath(target.storePath).path],
      },
    ),
  );
  if (!("messages" in value)) {
    throw new Error("Session context worker returned a different context operation");
  }
  return value;
}

export async function prepareSessionEntryInWorker(
  absPath: string,
  options: SessionEntryWorkerInput["options"],
) {
  const result = await readSessionEntryInWorker({
    kind: "session-entry",
    absPath,
    options,
  });
  if (!("entry" in result)) {
    throw new Error("Session transcript worker returned a snapshot instead of an export");
  }
  return result;
}

export async function prepareSessionEntriesInWorker(entries: SessionEntriesWorkerInput["entries"]) {
  const prepared: SessionEntriesWorkerResult["entries"] = [];
  let received = 0;
  const result = unwrapSessionTranscriptWorkerReply<
    "session-entry" | "session-entries" | "session-reset-recall"
  >(
    await sessionEntries.run(
      {
        kind: "session-entries",
        entries: entries.map((entry) => {
          const receipt = resolveSessionTranscriptReadFence(entry.options);
          return { ...entry, ...(receipt ? { admission: { ...receipt } } : {}) };
        }),
      },
      {
        inputBytes: JSON.stringify(entries).length * 2,
        onRequest: async (progress) => {
          // SAFETY: The paired worker publishes one complete entry before reading its next batch.
          const update = progress as {
            kind: "session-entries";
            index: number;
            value: SessionEntriesWorkerResult["entries"][number];
          };
          if (
            update.kind !== "session-entries" ||
            !Number.isInteger(update.index) ||
            update.index < 0 ||
            update.index >= entries.length ||
            update.index in prepared
          ) {
            throw new Error("Invalid session export delivery");
          }
          prepared[update.index] = update.value;
          received++;
          return { input: undefined, timeoutMs: 60_000 };
        },
      },
      {
        storePaths: entries.map(({ options }) => options.storePath),
        admissionPaths: [
          ...new Set(
            entries.map(
              ({ options }) =>
                resolveUnsuffixedSqliteTargetFromSessionStorePath(options.storePath).path,
            ),
          ),
        ],
      },
    ),
  );
  if (!("entries" in result)) {
    throw new Error("Session transcript worker returned a single export instead of a batch");
  }
  if (received !== entries.length) {
    throw new Error("Session transcript worker returned an incomplete export batch");
  }
  return prepared;
}

export async function readSessionEntrySnapshotInWorker(
  absPath: string,
  options: SessionEntryWorkerInput["options"],
  includeOriginalMessages: boolean,
) {
  const result = await readSessionEntryInWorker({
    kind: "session-entry",
    mode: "snapshot",
    includeOriginalMessages,
    absPath,
    options,
  });
  if (!("snapshot" in result)) {
    throw new Error("Session transcript worker returned an export instead of a snapshot");
  }
  return result.snapshot;
}

async function readSessionEntryInWorker(input: SessionEntryWorkerInput) {
  const { absPath, options } = input;
  const receipt = resolveSessionTranscriptReadFence(options);
  const result = unwrapSessionTranscriptWorkerReply<
    "session-entry" | "session-entries" | "session-reset-recall"
  >(
    await sessionEntries.run(
      {
        ...input,
        ...(receipt ? { admission: { ...receipt } } : {}),
      },
      {
        inputBytes:
          2 *
          (absPath.length +
            options.agentId.length +
            options.sessionId.length +
            options.storePath.length +
            (options.sessionKey?.length ?? 0)),
      },
      {
        storePaths: [options.storePath],
        admissionPaths: [resolveUnsuffixedSqliteTargetFromSessionStorePath(options.storePath).path],
      },
    ),
  );
  if (!("entry" in result) && !("snapshot" in result)) {
    throw new Error("Session transcript worker returned reset metadata instead of an export");
  }
  return result;
}

export async function readSessionResetRecallCutoffInWorker(
  scope: SessionResetRecallWorkerInput["scope"],
) {
  const receipt = resolveSessionTranscriptReadFence(scope);
  const result = unwrapSessionTranscriptWorkerReply<
    "session-entry" | "session-entries" | "session-reset-recall"
  >(
    await sessionEntries.run(
      {
        kind: "session-reset-recall",
        scope,
        ...(receipt ? { admission: { ...receipt } } : {}),
      },
      { inputBytes: JSON.stringify(scope).length * 2 },
      {
        storePaths: [scope.storePath],
        admissionPaths: [resolveUnsuffixedSqliteTargetFromSessionStorePath(scope.storePath).path],
      },
    ),
  );
  if (!("cutoff" in result)) {
    throw new Error("Session transcript worker returned an export instead of reset metadata");
  }
  return result.cutoff;
}
