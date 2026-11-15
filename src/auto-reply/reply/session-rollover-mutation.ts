import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { runSessionMutation } from "../../sessions/session-controller.lifecycle.js";
import {
  SessionMutationPreemptTimeoutError,
  type SessionMutationPreemptOptions,
} from "../../sessions/session-controller.mutation-preemption.js";

type StopChildren = NonNullable<SessionMutationPreemptOptions["stopChildren"]>;

/** Runs one reply-session rollover through the controller's reset policy. */
export async function runReplySessionRolloverMutation<T>(params: {
  storePath: string;
  sessionKey: string;
  sessionId: string;
  explicitReset: boolean;
  signal?: AbortSignal;
  shouldPreempt: () => boolean;
  stopChildren: StopChildren;
  prepare: () => Promise<void>;
  run: () => Promise<T>;
}): Promise<T> {
  try {
    return await runSessionMutation({
      scope: params.storePath,
      identities: [params.sessionKey, params.sessionId],
      // Implicit rollover must not stop a newer session generation. Explicit
      // reset instead reacquires and preempts the current generation as before.
      requiredSessionId: params.explicitReset ? undefined : params.sessionId,
      signal: params.signal,
      kind: "reset",
      policy: "preempt",
      preempt: {
        activeRun: "abort",
        waitingInputs: "cancel",
        reason: createAgentRunRestartAbortError(),
        shouldPreempt: params.shouldPreempt,
        stopChildren: params.stopChildren,
      },
      prepare: params.prepare,
      run: params.run,
    });
  } catch (error) {
    if (error instanceof SessionMutationPreemptTimeoutError) {
      throw new Error(
        `timed out draining work before reply session rollover: ${params.sessionKey}`,
        { cause: error },
      );
    }
    throw error;
  }
}
