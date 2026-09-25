import { ensureSqliteLibrarySelected } from "../../infra/bun-sqlite-library.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import type { SensitiveTextRedactionSnapshot } from "../../logging/redact.js";
import type { SessionBranchSummaryReadRequest } from "./session-accessor.sqlite-branches.js";
import type { readSessionTranscriptModelContext } from "./session-accessor.sqlite-model-context.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import { unwrapSessionTranscriptWorkerReply } from "./session-history-worker-errors.js";
import { resolveSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import type {
  SessionBranchSummaryWorkerInput,
  SessionEntryWorkerInput,
  SessionResetRecallWorkerInput,
  SessionModelContextWorkerInput,
  SessionSqliteTargetWorkerInput,
  SessionTranscriptWorkerReply,
} from "./session-transcript-worker.types.js";

// Bun loads one SQLite library per process; workers must inherit the parent's selection.
function prepareSqliteReadWorker() {
  ensureSqliteLibrarySelected();
  return { options: {} };
}

const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscript);
const modelContextReads = new WorkerTaskPool<
  SessionModelContextWorkerInput | SessionSqliteTargetWorkerInput,
  SessionTranscriptWorkerReply<"model-context" | "sqlite-target">
>({
  workerUrl,
  prepareWorker: prepareSqliteReadWorker,
  workerOptions: { resourceLimits: { maxOldGenerationSizeMb: 512 } },
  // Preserve context-read admission order and avoid multiplying large SQLite scans.
  maxWorkers: 1,
});

// Background transcript exports cannot occupy the foreground context worker.
const sessionEntries = new WorkerTaskPool<
  SessionEntryWorkerInput | SessionResetRecallWorkerInput,
  SessionTranscriptWorkerReply<"session-entry" | "session-reset-recall">
>({
  workerUrl,
  prepareWorker: prepareSqliteReadWorker,
  workerOptions: { resourceLimits: { maxOldGenerationSizeMb: 512 } },
  maxWorkers: 1,
  sharedCompute: true,
});

// Branch scans share background compute admission without delaying foreground history or context.
const branchSummaries = new WorkerTaskPool<
  SessionBranchSummaryWorkerInput,
  SessionTranscriptWorkerReply<"branch-summaries">
>({
  workerUrl,
  prepareWorker: prepareSqliteReadWorker,
  workerOptions: { resourceLimits: { maxOldGenerationSizeMb: 512 } },
  maxWorkers: 1,
  sharedCompute: true,
});

export async function readSessionTranscriptModelContextAsync(
  target: SessionTranscriptRuntimeTarget,
  admission: SessionModelContextWorkerInput["admission"],
  signal?: AbortSignal,
  through?: SessionModelContextWorkerInput["through"],
  limits?: SessionModelContextWorkerInput["limits"],
): Promise<ReturnType<typeof readSessionTranscriptModelContext>> {
  signal?.throwIfAborted();
  const value = unwrapSessionTranscriptWorkerReply<"model-context" | "sqlite-target">(
    await modelContextReads.run(
      { kind: "model-context", target, admission, through, limits },
      { timeoutMs: 60_000, signal },
    ),
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
  const value = unwrapSessionTranscriptWorkerReply<"model-context" | "sqlite-target">(
    await modelContextReads.run(
      { kind: "sqlite-target", ...input },
      { inputBytes: JSON.stringify(input).length * 2, timeoutMs: 60_000, signal },
    ),
  );
  if (!("target" in value)) {
    throw new Error("Session context worker returned context instead of a database target");
  }
  return value.target;
}

export async function prepareSessionEntryInWorker(
  absPath: string,
  options: SessionEntryWorkerInput["options"],
  redaction: SensitiveTextRedactionSnapshot,
) {
  const receipt = resolveSessionTranscriptReadFence(options);
  const result = unwrapSessionTranscriptWorkerReply<"session-entry" | "session-reset-recall">(
    await sessionEntries.run(
      {
        kind: "session-entry",
        absPath,
        options,
        redaction,
        ...(receipt ? { admission: { ...receipt } } : {}),
      },
      {
        inputBytes:
          2 *
          (absPath.length +
            options.agentId.length +
            options.sessionId.length +
            options.storePath.length +
            (options.sessionKey?.length ?? 0) +
            redaction.registeredSecretValues.reduce((bytes, value) => bytes + value.length, 0)),
      },
    ),
  );
  if (!("entry" in result)) {
    throw new Error("Session transcript worker returned reset metadata instead of an export");
  }
  return result;
}

export async function readSessionResetRecallCutoffInWorker(
  scope: SessionResetRecallWorkerInput["scope"],
) {
  const receipt = resolveSessionTranscriptReadFence(scope);
  const result = unwrapSessionTranscriptWorkerReply<"session-entry" | "session-reset-recall">(
    await sessionEntries.run(
      {
        kind: "session-reset-recall",
        scope,
        ...(receipt ? { admission: { ...receipt } } : {}),
      },
      { inputBytes: JSON.stringify(scope).length * 2 },
    ),
  );
  if (!("cutoff" in result)) {
    throw new Error("Session transcript worker returned an export instead of reset metadata");
  }
  return result.cutoff;
}

export async function runSessionBranchSummaryWorkerRequest(
  request: SessionBranchSummaryReadRequest,
  signal: AbortSignal,
) {
  return unwrapSessionTranscriptWorkerReply<"branch-summaries">(
    await branchSummaries.run(
      { kind: "branch-summaries", request },
      {
        inputBytes:
          2 *
          (request.database.agentId.length +
            request.database.path.length +
            request.databaseIdentity.length +
            request.sessionKey.length +
            request.sessionId.length +
            (request.lifecycleRevision?.length ?? 0)),
        timeoutMs: 60_000,
        signal,
      },
    ),
  );
}
