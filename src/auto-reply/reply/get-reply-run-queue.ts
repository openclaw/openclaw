import { logVerbose } from "../../globals.js";
import type { ReplyPayload } from "../types.js";
import type { ActiveRunQueueAction } from "./queue-policy.js";
import type { QueueSettings } from "./queue.js";

export type ReplyRunQueueBusyState = {
  activeSessionId: string | undefined;
  isActive: boolean;
  isStreaming: boolean;
};

export async function resolvePreparedReplyQueueState(params: {
  activeRunQueueAction: ActiveRunQueueAction;
  activeSessionId: string | undefined;
  queueMode: QueueSettings["mode"];
  sessionKey: string | undefined;
  sessionId: string;
  abortActiveRun: (sessionId: string) => boolean;
  waitForActiveRunEnd: (sessionId: string) => Promise<unknown>;
  /** Force-detach the run from the scheduling registry (two-phase abort). */
  forceDetachActiveRun?: (sessionId: string) => boolean;
  refreshPreparedState: () => Promise<void>;
  resolveBusyState: () => ReplyRunQueueBusyState;
}): Promise<
  | { kind: "continue"; busyState: ReplyRunQueueBusyState; waitInterrupted?: boolean }
  | { kind: "reply"; reply: ReplyPayload }
> {
  if (params.activeRunQueueAction !== "run-now" || !params.activeSessionId) {
    return { kind: "continue", busyState: params.resolveBusyState() };
  }

  if (params.queueMode === "interrupt") {
    const aborted = params.abortActiveRun(params.activeSessionId);
    logVerbose(
      `Interrupting active run for ${params.sessionKey ?? params.sessionId} (aborted=${aborted})`,
    );
  }

  const waitResult = await params.waitForActiveRunEnd(params.activeSessionId);
  await params.refreshPreparedState();
  const refreshedBusyState = params.resolveBusyState();
  if (refreshedBusyState.isActive) {
    if (params.queueMode === "interrupt" && params.forceDetachActiveRun) {
      // Only force-detach when the wait actually timed out (waitResult falsy).
      // If the aborted run ended cleanly but isActive is still true, a
      // concurrent replacement run has already started — force-detaching it
      // would kill a legitimate run.  In that case, skip the detach and let
      // the downstream createReplyOperation({ force: true }) handle the
      // supersede via the cleaner abort+clearState path.
      if (!waitResult) {
        const detached = params.forceDetachActiveRun(params.activeSessionId);
        logVerbose(
          `Force-detach attempt for ${params.sessionKey ?? params.sessionId} after interrupt timeout (detached=${detached})`,
        );
      } else {
        logVerbose(
          `Skipped force-detach for ${params.sessionKey ?? params.sessionId}: aborted run ended, concurrent run detected`,
        );
      }
      // The scheduling layer has committed to superseding the old run.
      // Proceed unconditionally — createReplyOperation({ force: true })
      // handles any residual ReplyOperation state.  Gating on the detach
      // return value would let delivery-layer state veto a scheduling-layer
      // decision, causing message loss.
      //
      // Note on rapid-burst: when two interrupt messages arrive concurrently
      // for the same chat (enabled by per-message sequential keys), only the
      // first to reach createReplyOperation({ force: true }) wins the slot.
      // The second sees the first message's new operation as active and
      // receives the "still shutting down" reply.  This is intentional —
      // only one replacement can be in-flight at a time.
      await params.refreshPreparedState();
      return {
        kind: "continue",
        busyState: params.resolveBusyState(),
        waitInterrupted: !waitResult,
      };
    }
    return {
      kind: "reply",
      reply: {
        text: "⚠️ Previous run is still shutting down. Please try again in a moment.",
      },
    };
  }
  return { kind: "continue", busyState: refreshedBusyState, waitInterrupted: false };
}
