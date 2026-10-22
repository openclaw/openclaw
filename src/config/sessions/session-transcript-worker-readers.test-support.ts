import type { WorkerTaskResponse } from "../../infra/worker-task-pool.types.js";
import type { SessionHistoryWorkerRequestRunner } from "./session-transcript-worker-readers.js";
import type {
  SessionHistoryWorkerPreparedInput,
  SessionTranscriptWorkerValues,
} from "./session-transcript-worker.types.js";

/** Test transport: each fixture answers the request it receives without starting a worker. */
export function createSessionHistoryWorkerRequestStub(
  run: (
    prepare: () => SessionHistoryWorkerPreparedInput,
    inputBytes: number,
    signal?: AbortSignal,
    onRequest?: (value: unknown, signal: AbortSignal) => void | Promise<WorkerTaskResponse>,
  ) => Promise<SessionTranscriptWorkerValues[SessionHistoryWorkerPreparedInput["kind"]]>,
): SessionHistoryWorkerRequestRunner {
  return async (prepare, inputBytes, receive, signal, onRequest) => {
    const value = await run(prepare, inputBytes, signal, onRequest);
    // SAFETY: The fixture supplies the response to this prepared request, like the real transport.
    const paired = value as SessionTranscriptWorkerValues[ReturnType<typeof prepare>["kind"]];
    return receive(paired);
  };
}
