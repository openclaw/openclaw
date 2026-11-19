import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import type { SessionPreparedCompactionInput } from "./session-compaction-prepared.types.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";

/** Capture source custody for each short worker read; never retain a reader across inference. */
export async function readPreparedSessionCompactionInWorker(
  target: SessionTranscriptRuntimeTarget,
  operation: SessionPreparedCompactionInput["operation"],
  signal?: AbortSignal,
) {
  const reader = prepareSessionTranscriptHydration(target, { compaction: true }, signal);
  if (!reader.readCompaction) {
    throw new Error("In-memory compaction uses its session actor");
  }
  return reader.readCompaction(operation);
}
