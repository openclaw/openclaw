import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import { captureSessionActorTranscriptRead } from "./session-actor-transcript-read.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";

/** Read statistics through the selected actor or durable history owner. */
export function readTranscriptStatsAsync(scope: SessionTranscriptReadScope) {
  const memory = captureSessionActorTranscriptRead(scope);
  if (memory) {
    if (memory.missing) {
      memory.assertCurrent();
      return Promise.resolve({ eventCount: 0, maxSeq: 0, sizeBytes: 0 });
    }
    return memory.read("session.history.stats", {});
  }
  return withSessionTranscriptReadSource(
    scope,
    ({ scope: captured, resolved, owner, expectedIdentity }) =>
      owner.readStats({ scope: { ...captured, sessionId: resolved.sessionId }, expectedIdentity }),
  );
}
