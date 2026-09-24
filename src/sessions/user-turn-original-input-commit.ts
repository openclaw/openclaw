import { isDeepStrictEqual } from "node:util";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  PersistedUserTurnMessage,
  UserTurnOriginalInputCommit,
  UserTurnTranscriptRecorder,
} from "./user-turn-transcript.types.js";

const sourceNotifiers = new WeakMap<
  UserTurnTranscriptRecorder,
  (anchor: UserTurnOriginalInputCommit["anchor"]) => Promise<void> | undefined
>();

/** Owns exactly-once commit effects and settlement across collected source recorders. */
export function createOriginalInputCommitObserver(params: {
  sources?: readonly UserTurnTranscriptRecorder[];
  isBlocked: () => boolean;
  getMessage: () => PersistedUserTurnMessage | undefined;
  onCommitted?: (commit: UserTurnOriginalInputCommit) => void | Promise<void>;
  onError: (error: unknown) => void;
}) {
  let originalInputCommitted = false;
  let originalInputCommitPromise: Promise<void> | undefined;
  const notifyOriginalInputCommitted = (
    commit: UserTurnOriginalInputCommit,
  ): Promise<void> | undefined => {
    const sourceMessage = commit.message;
    const metadata = sourceMessage["__openclaw"];
    if (
      originalInputCommitted ||
      params.isBlocked() ||
      sourceMessage.display === false ||
      sourceMessage.excludeFromContext === true ||
      (sourceMessage.provenance && sourceMessage.provenance.kind !== "external_user") ||
      metadata?.lateMedia === true ||
      metadata?.beforeAgentRunBlocked !== undefined
    ) {
      return originalInputCommitPromise;
    }
    originalInputCommitted = true;
    // Publish ownership before invoking callbacks: commit observers can reenter
    // this recorder, but neither their failure nor replay may retry the effect.
    const completion = createDeferredCore();
    originalInputCommitPromise = completion.promise;
    const accepted: Promise<void>[] = [];
    // Collection commits one framed message, but each source owns its sender and
    // selections. A rewritten aggregate no longer attests those original bytes.
    if (
      params.sources &&
      metadata?.humanMentions?.length &&
      isDeepStrictEqual(sourceMessage.content, params.getMessage()?.content)
    ) {
      for (const source of params.sources) {
        const pending = sourceNotifiers.get(source)?.(commit.anchor);
        if (pending) {
          accepted.push(pending);
        }
      }
    }
    try {
      accepted.push(Promise.resolve(params.onCommitted?.(commit)).catch(params.onError));
    } catch (error) {
      params.onError(error);
    }
    // Callbacks start synchronously at the commit edge; persistence/lifecycle
    // joins their accepted work outside the synchronous transcript writer.
    void Promise.all(accepted).then(() => completion.resolve());
    return originalInputCommitPromise;
  };

  return {
    notify: notifyOriginalInputCommitted,
    get pending() {
      return originalInputCommitPromise;
    },
    bind(recorder: UserTurnTranscriptRecorder) {
      sourceNotifiers.set(recorder, (anchor) => {
        const sourceMessage = params.getMessage();
        return sourceMessage
          ? notifyOriginalInputCommitted({ message: sourceMessage, anchor })
          : undefined;
      });
    },
  };
}
