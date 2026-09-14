import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import type { SensitiveTextRedactionSnapshot } from "../../logging/redact.js";
import type { SessionBranchSummaryReadRequest } from "./session-accessor.sqlite-branches.js";
import type { readSessionTranscriptModelContext } from "./session-accessor.sqlite-model-context.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import {
  resolveSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import type {
  SessionColdPreparationWorkerInput,
  SessionEntryWorkerInput,
  SessionBranchSummaryWorkerInput,
  SessionTranscriptHistoryWorkerInput,
  SessionModelContextWorkerInput,
  SessionTranscriptWorkerReply,
} from "./session-transcript.worker.js";

const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscript);
const modelContextReads = new WorkerTaskPool<
  SessionModelContextWorkerInput,
  SessionTranscriptWorkerReply<"model-context">
>({
  workerUrl,
  // Preserve context-read admission order and avoid multiplying large SQLite scans.
  maxWorkers: 1,
});

// Background transcript exports cannot occupy the foreground context worker.
const sessionEntries = new WorkerTaskPool<
  SessionEntryWorkerInput,
  SessionTranscriptWorkerReply<"session-entry">
>({ workerUrl, maxWorkers: 1, sharedCompute: true });

const historyPages = new WorkerTaskPool<
  SessionTranscriptHistoryWorkerInput | SessionColdPreparationWorkerInput,
  SessionTranscriptWorkerReply<"history-page"> | SessionTranscriptWorkerReply<"cold-preparation">
>({ workerUrl, maxWorkers: 1 });

// Branch scans share background compute admission without delaying foreground history or context.
const branchSummaries = new WorkerTaskPool<
  SessionBranchSummaryWorkerInput,
  SessionTranscriptWorkerReply<"branch-summaries">
>({ workerUrl, maxWorkers: 1, sharedCompute: true });

function unwrapReply<
  Kind extends
    | "model-context"
    | "session-entry"
    | "history-page"
    | "branch-summaries"
    | "cold-preparation",
>(reply: SessionTranscriptWorkerReply<Kind>) {
  if (reply.ok) {
    return reply.value;
  }
  if (reply.error.kind === "cold") {
    throw new SessionTranscriptColdError(reply.error.sessionId);
  }
  if (reply.error.kind === "projection") {
    throw new SessionTranscriptProjectionUnavailableError(reply.error.sessionId);
  }
  throw new SessionTranscriptReadFenceError(reply.error.message);
}

export async function readSessionTranscriptModelContextAsync(
  target: SessionTranscriptRuntimeTarget,
  admission: SessionModelContextWorkerInput["admission"],
  signal?: AbortSignal,
  through?: SessionModelContextWorkerInput["through"],
): Promise<ReturnType<typeof readSessionTranscriptModelContext>> {
  signal?.throwIfAborted();
  return unwrapReply<"model-context">(
    await modelContextReads.run(
      { kind: "model-context", target, admission, through },
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
  return unwrapReply<"session-entry">(
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

export async function runSessionHistoryWorkerRequest(
  prepare: () => SessionTranscriptHistoryWorkerInput,
  inputBytes: number,
) {
  const result = unwrapReply<"history-page" | "cold-preparation">(
    await historyPages.run(prepare, { inputBytes, timeoutMs: 60_000 }),
  );
  if ("target" in result) {
    throw new Error("Session history worker returned preparation instead of a page");
  }
  return result;
}

export async function runSessionBranchSummaryWorkerRequest(
  request: SessionBranchSummaryReadRequest,
  signal: AbortSignal,
) {
  return unwrapReply<"branch-summaries">(
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

export async function runSessionColdPreparationWorkerRequest(
  request: SessionColdPreparationWorkerInput["request"],
) {
  const result = unwrapReply<"history-page" | "cold-preparation">(
    await historyPages.run(
      { kind: "cold-preparation", request },
      { inputBytes: JSON.stringify(request).length * 2, timeoutMs: 60_000 },
    ),
  );
  if (!("target" in result)) {
    throw new Error("Session history worker returned a page instead of preparation");
  }
  return result;
}
