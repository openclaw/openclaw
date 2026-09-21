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
  SessionModelContextWorkerInput,
  SessionTranscriptWorkerReply,
} from "./session-transcript-worker.types.js";

const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscript);
const modelContextReads = new WorkerTaskPool<
  SessionModelContextWorkerInput,
  SessionTranscriptWorkerReply<"model-context">
>({
  workerUrl,
  workerOptions: { resourceLimits: { maxOldGenerationSizeMb: 512 } },
  // Preserve context-read admission order and avoid multiplying large SQLite scans.
  maxWorkers: 1,
});

// Background transcript exports cannot occupy the foreground context worker.
const sessionEntries = new WorkerTaskPool<
  SessionEntryWorkerInput,
  SessionTranscriptWorkerReply<"session-entry">
>({
  workerUrl,
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
  return unwrapSessionTranscriptWorkerReply<"model-context">(
    await modelContextReads.run(
      { kind: "model-context", target, admission, through, limits },
      { timeoutMs: 60_000, signal },
    ),
  );
}

export async function prepareSessionEntryInWorker(
  absPath: string,
  options: SessionEntryWorkerInput["options"],
  redaction: SensitiveTextRedactionSnapshot,
) {
  const receipt = resolveSessionTranscriptReadFence(options);
  return unwrapSessionTranscriptWorkerReply<"session-entry">(
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
