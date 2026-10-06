import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { readSessionTranscriptModelContext } from "./session-accessor.sqlite-model-context.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import type {
  SessionModelContextLimits,
  SessionTranscriptModelContext,
} from "./session-history-read.types.js";
import { captureIncognitoSessionHistoryBinding } from "./session-incognito-binding.js";
import {
  prepareIncognitoSessionHistoryRead,
  type IncognitoSessionHistoryBinding,
} from "./session-incognito-history-read.js";
import { readSessionTranscriptAnchorsAsync } from "./session-transcript-anchor-read.js";
import {
  withSessionContextAdmission,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";
import { readSessionTranscriptModelContextInWorker } from "./session-transcript-read-worker-runtime.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

/** Accept consumed results while the original writer FIFO and native witness remain current. */
export function readSessionTranscriptModelContextAsync<T>(
  target: SessionTranscriptRuntimeTarget,
  consume: (context: SessionTranscriptModelContext) => T,
  admission?: UserTurnTranscriptAdmissionReceipt,
  signal?: AbortSignal,
  through?: TranscriptEntryAnchor,
  limits?: SessionModelContextLimits,
  suppliedIncognito?: IncognitoSessionHistoryBinding,
): Promise<T> {
  const capturedTarget = { ...target };
  const capturedAdmission = admission ? structuredClone(admission) : undefined;
  const capturedThrough = through ? structuredClone(through) : undefined;
  const capturedLimits = limits ? { ...limits } : undefined;
  const accept = async (
    scope: SessionTranscriptRuntimeTarget,
    context: SessionTranscriptModelContext,
    assertCurrent: () => void,
    binding?: IncognitoSessionHistoryBinding,
    contextAdmission = capturedAdmission,
  ): Promise<T> => {
    const contextValidation = structuredClone({
      version: context.version,
      admission: contextAdmission,
      through: capturedThrough,
    });
    const validate = async <Value>(publish: () => Value): Promise<{ value: Value }> => {
      let accepted: { value: Value } | undefined;
      await readSessionTranscriptAnchorsAsync(
        scope,
        { entryIds: [], contextValidation },
        signal,
        (facts) => {
          assertCurrent();
          if (
            !facts.contextValidated &&
            (contextValidation.version || contextAdmission || capturedThrough)
          ) {
            throw new SessionTranscriptReadFenceError(
              "Session transcript changed during context read",
            );
          }
          accepted = { value: publish() };
        },
        binding,
      );
      if (!accepted) {
        throw new SessionTranscriptReadFenceError("Session transcript changed during context read");
      }
      return accepted;
    };
    let consumerSettlement: Promise<Awaited<T>> | undefined;
    let joined = false;
    try {
      const accepted = await validate(() => {
        const value = consume(context);
        if (isPromiseLike(value)) {
          consumerSettlement = Promise.resolve(value);
          void consumerSettlement.catch(() => undefined);
        }
        return value;
      });
      if (!consumerSettlement) {
        return accepted.value;
      }
      const value = await consumerSettlement;
      joined = true;
      return (await validate(() => value)).value;
    } finally {
      // Initial acceptance can fail after starting a consumer; its owner still joins that work.
      if (consumerSettlement && !joined) {
        await consumerSettlement.catch(() => undefined);
      }
    }
  };
  const incognito = suppliedIncognito ?? captureIncognitoSessionHistoryBinding(target);
  if (incognito) {
    const prepared = prepareIncognitoSessionHistoryRead(incognito, target, signal);
    const contextAdmission = capturedAdmission ?? prepared.target.admission;
    return prepared.actor.sessions
      .withSharedState(async () => {
        const context = await prepared.actor.sessions.history(
          prepared.authority,
          {
            type: "session.history.context",
            input: {
              ...prepared.target,
              admission: contextAdmission,
              through: capturedThrough,
              limits: capturedLimits,
            },
          },
          signal,
        );
        return accept(
          capturedTarget,
          context,
          prepared.authority.assertCurrent,
          prepared,
          contextAdmission,
        );
      })
      .then((result) => {
        prepared.authority.assertCurrent();
        return result;
      });
  }
  return withSessionTranscriptReadSource(
    capturedTarget,
    async (scope) => {
      // Capture incognito synchronously, then revalidate after the public async boundary.
      const context = await Promise.resolve(
        withSessionContextAdmission(capturedTarget, capturedAdmission, () =>
          readSessionTranscriptModelContext(scope, capturedThrough, capturedLimits),
        ),
      );
      return accept(capturedTarget, context, () => signal?.throwIfAborted());
    },
    async ({ scope, expectedIdentity, assertCurrent }) => {
      const captured = { ...scope, sessionKey: capturedTarget.sessionKey };
      const context = await readSessionTranscriptModelContextInWorker(
        captured,
        capturedAdmission,
        signal,
        capturedThrough,
        capturedLimits,
        expectedIdentity,
      );
      assertCurrent();
      return accept(captured, context, assertCurrent);
    },
    signal,
  );
}
