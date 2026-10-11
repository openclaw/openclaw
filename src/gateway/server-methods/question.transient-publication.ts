import type { QuestionResolvedEvent } from "../../../packages/gateway-protocol/src/index.js";
import { handleQuestionChannelResolved } from "../../infra/question-channel-runtime.js";
import type { QuestionObservation } from "../question-manager.js";
import {
  withPreparedQuestionSessions,
  type PreparedQuestionSession,
} from "../question-session-access.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Transient questions retain their originating invocation's publication lifetime. */
export function createTransientQuestionPublication(
  options: GatewayRequestHandlerOptions,
  publish: (
    event: QuestionResolvedEvent,
    observation: QuestionObservation,
    current: PreparedQuestionSession | undefined,
  ) => void,
) {
  return async (event: QuestionResolvedEvent, observation: QuestionObservation) => {
    handleQuestionChannelResolved(event);
    let consumed = false;
    try {
      await withPreparedQuestionSessions(
        options,
        [
          {
            ...observation.record,
            sessionAccess: observation.sessionAccess,
          },
        ],
        ([current]) => {
          consumed = true;
          if (!observation.isCurrent()) {
            return;
          }
          publish(event, observation, current);
        },
        {
          assertCurrent: () => {
            if (!observation.isCurrent()) {
              throw new Error("Question publication owner retired");
            }
          },
        },
      );
    } catch (error) {
      if (consumed || !observation.isCurrent()) {
        throw error;
      }
      // A failed optional read grants no narrow access. Publish only to
      // recipients the sharing owner admits with unknown session facts.
      publish(event, observation, undefined);
    }
  };
}
