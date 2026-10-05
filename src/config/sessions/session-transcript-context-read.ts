import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { readSessionTranscriptModelContext } from "./session-accessor.sqlite-model-context.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import type {
  SessionModelContextLimits,
  SessionTranscriptModelContext,
} from "./session-history-read.types.js";
import { readSessionTranscriptAnchorsAsync } from "./session-transcript-anchor-read.js";
import {
  withSessionContextAdmission,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";
import { readSessionTranscriptModelContextInWorker } from "./session-transcript-read-worker-runtime.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

/** Consume synchronously while the final validation retains its writer FIFO and native witness. */
export function readSessionTranscriptModelContextAsync<T>(
  target: SessionTranscriptRuntimeTarget,
  consume: (context: SessionTranscriptModelContext) => T,
  admission?: UserTurnTranscriptAdmissionReceipt,
  signal?: AbortSignal,
  through?: TranscriptEntryAnchor,
  limits?: SessionModelContextLimits,
): Promise<T> {
  const capturedTarget = { ...target };
  const accept = async (
    scope: SessionTranscriptRuntimeTarget,
    context: SessionTranscriptModelContext,
    assertCurrent: () => void,
  ): Promise<T> => {
    let accepted: { value: T } | undefined;
    await readSessionTranscriptAnchorsAsync(
      scope,
      {
        entryIds: [],
        contextValidation: { version: context.version, admission, through },
      },
      signal,
      (facts) => {
        assertCurrent();
        if (!facts.contextValidated && (context.version || admission || through)) {
          throw new SessionTranscriptReadFenceError(
            "Session transcript changed during context read",
          );
        }
        accepted = { value: consume(context) };
      },
    );
    if (!accepted) {
      throw new SessionTranscriptReadFenceError("Session transcript changed during context read");
    }
    return accepted.value;
  };
  return withSessionTranscriptReadSource(
    capturedTarget,
    async (scope) => {
      // Capture incognito synchronously, then revalidate after the public async boundary.
      const context = await Promise.resolve(
        withSessionContextAdmission(capturedTarget, admission, () =>
          readSessionTranscriptModelContext(scope, through, limits),
        ),
      );
      return accept(capturedTarget, context, () => signal?.throwIfAborted());
    },
    async ({ scope, expectedIdentity, assertCurrent }) => {
      const captured = { ...scope, sessionKey: capturedTarget.sessionKey };
      const context = await readSessionTranscriptModelContextInWorker(
        captured,
        admission,
        signal,
        through,
        limits,
        expectedIdentity,
      );
      assertCurrent();
      return accept(captured, context, assertCurrent);
    },
    signal,
  );
}
