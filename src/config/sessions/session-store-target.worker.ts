import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { encodeSessionTranscriptWorkerError } from "./session-history-worker-errors.js";
import {
  prepareSessionStoreTargetCandidates,
  readSessionStoreTargetResult,
} from "./session-store-target-inventory.js";
import type { SessionHistoryWorkerInput } from "./session-transcript-worker.types.js";

export function readSessionStoreTargetWorkerRequest(
  request: Extract<
    SessionHistoryWorkerInput,
    { kind: "session-target-prepare" | "session-store-target" }
  >,
) {
  if (request.kind === "session-target-prepare") {
    return prepareSessionStoreTargetCandidates(request.request);
  }
  request.request.env = cloneEnvWithPlatformSemantics(request.request.env);
  const read = readSessionStoreTargetResult(request.request);
  if (read.ok) {
    return read.value;
  }
  const readError = encodeSessionTranscriptWorkerError(read.error);
  if (!readError) {
    throw read.error;
  }
  return { kind: "session-store-target" as const, readError };
}
