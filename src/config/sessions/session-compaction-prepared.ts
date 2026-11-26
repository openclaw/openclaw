import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import { readRestoredSessionTranscriptInWorker } from "./session-cold-storage-read.js";
import type { SessionPreparedCompactionInput } from "./session-compaction-prepared.types.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";

/** Each call captures current source custody; a plan never retains a reader across inference. */
export function readPreparedSessionCompactionInWorker(
  target: SessionTranscriptRuntimeTarget,
  operation: SessionPreparedCompactionInput["operation"],
  signal?: AbortSignal,
  timeoutMs?: number,
) {
  return withSessionTranscriptReadSource(
    target,
    async (source) => {
      source.assertCurrent();
      const result = await readRestoredSessionTranscriptInWorker(source, () =>
        source.owner.readPreparedCompaction(
          {
            target: { ...source.scope, sessionId: target.sessionId, sessionKey: target.sessionKey },
            resolvedScope: source.resolved,
            expectedIdentity: source.expectedIdentity,
            operation,
            caller: "compaction",
          },
          signal,
          { timeoutMs },
        ),
      );
      source.assertCurrent();
      return result;
    },
    signal,
  );
}
