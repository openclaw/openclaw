import type { SessionTranscriptReadScope } from "../../config/sessions/session-accessor.sqlite-contract.js";
import { isSessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseAdmissionErrorShape,
} from "../../state/agent-database-admission.js";

const ACCEPTED_CHAT_SEND_MAX_DISPATCH_ATTEMPTS = 3;

export type AcceptedChatSendFailureDisposition =
  | "client-retry"
  | "reconcile"
  | "retry"
  | "terminal";

/** Classify an accepted-send failure without relying on unstable error text. */
export function classifyAcceptedChatSendFailure(params: {
  error: unknown;
  phase: "pre-ack" | "post-ack";
  executionStarted?: boolean;
  sideEffectsObserved?: boolean;
}): AcceptedChatSendFailureDisposition {
  if (params.executionStarted || params.sideEffectsObserved) {
    return "reconcile";
  }
  if (
    params.phase === "pre-ack" &&
    params.error instanceof AgentDatabaseAdmissionError &&
    createAgentDatabaseAdmissionErrorShape(params.error.refusal).retryable
  ) {
    return "client-retry";
  }
  if (!isSessionTranscriptProjectionUnavailableError(params.error)) {
    return "terminal";
  }
  return params.phase === "post-ack" ? "retry" : "client-retry";
}

/** Wait for the exact failed projection before another accepted-send dispatch attempt. */
export async function waitForAcceptedChatSendRetry(
  scope: Omit<SessionTranscriptReadScope, "sessionId">,
  error: unknown,
  abortSignal: AbortSignal,
): Promise<void> {
  if (!isSessionTranscriptProjectionUnavailableError(error)) {
    throw error;
  }
  await waitForSessionTranscriptProjection({ ...scope, sessionId: error.sessionId }, abortSignal);
}

/** One Gateway budget covers setup and retries inside the already-admitted resolver. */
export function createAcceptedChatSendRetry(params: {
  waitForRetry: (error: unknown) => Promise<void>;
  classify: (error: unknown) => AcceptedChatSendFailureDisposition;
}): <T>(operation: () => Promise<T>) => Promise<T> {
  let retriesRemaining = ACCEPTED_CHAT_SEND_MAX_DISPATCH_ATTEMPTS - 1;
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (retriesRemaining === 0 || params.classify(error) !== "retry") {
          throw error;
        }
        retriesRemaining -= 1;
        await params.waitForRetry(error);
      }
    }
  };
}
