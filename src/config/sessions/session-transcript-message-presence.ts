import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import { captureSessionActorTranscriptRead } from "./session-actor-transcript-read.js";
import { readRestoredSessionTranscriptInWorker } from "./session-cold-storage-read.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";

/** Read the cold marker and both message probes in the history worker's one snapshot. */
export function hasSessionTranscriptMessage(scope: SessionTranscriptReadScope): Promise<boolean> {
  const memory = captureSessionActorTranscriptRead(scope);
  if (memory) {
    if (memory.missing) {
      memory.assertCurrent();
      return Promise.resolve(false);
    }
    return memory.read("session.history.message-presence", {});
  }
  return withSessionTranscriptReadSource(scope, (source) =>
    readRestoredSessionTranscriptInWorker(source, () =>
      source.owner.readMessagePresence({
        scope: source.scope,
        expectedIdentity: source.expectedIdentity,
      }),
    ),
  );
}
