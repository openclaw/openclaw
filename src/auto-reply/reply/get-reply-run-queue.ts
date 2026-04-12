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
  { kind: "continue"; busyState: ReplyRunQueueBusyState } | { kind: "reply"; reply: ReplyPayload }
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

  await params.waitForActiveRunEnd(params.activeSessionId);
  await params.refreshPreparedState();
  const refreshedBusyState = params.resolveBusyState();
  if (refreshedBusyState.isActive) {
    // Abort was signaled but the run's cleanup timed out (provider HTTP drain,
    // compaction, etc.).  In interrupt mode, force-detach the old run from the
    // scheduling registry so a new run can start immediately.  The old run's
    // finally block will still complete asynchronously — it just no longer
    // blocks the registry (its clearActiveEmbeddedRun call becomes a no-op
    // due to handle identity mismatch).
    if (params.queueMode === "interrupt" && params.forceDetachActiveRun) {
      const detached = params.forceDetachActiveRun(params.activeSessionId);
      if (detached) {
        logVerbose(
          `Force-detached stale run for ${params.sessionKey ?? params.sessionId} after interrupt timeout`,
        );
        // forceDetach has released the scheduling slot. A residual ReplyOperation
        // may still be registered (its clearState runs in the old run's finally
        // block), but the downstream createReplyOperation({ force: true }) will
        // abort and clear it synchronously. Re-checking isActive here would
        // incorrectly reject the new run based on delivery-layer state that
        // the scheduling layer already decided to supersede.
        //
        // Note on rapid-burst: when two interrupt messages arrive concurrently
        // for the same chat (enabled by per-message sequential keys), only the
        // first to reach createReplyOperation({ force: true }) wins the slot.
        // The second sees the first message's new operation as active and
        // receives the "still shutting down" reply. This is intentional —
        // only one replacement can be in-flight at a time.
        await params.refreshPreparedState();
        return { kind: "continue", busyState: params.resolveBusyState() };
      }
    }
    return {
      kind: "reply",
      reply: {
        text: "⚠️ Previous run is still shutting down. Please try again in a moment.",
      },
    };
  }
  return { kind: "continue", busyState: refreshedBusyState };
}
