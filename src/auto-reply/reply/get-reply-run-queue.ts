/** Active-run queue admission for prepared reply turns. */
import type { ReplyPayload } from "../types.js";
import type { QueueSettings } from "./queue.js";

export const REPLY_RUN_STILL_SHUTTING_DOWN_TEXT =
  "⚠️ Previous run is still shutting down. Please try again in a moment.";

/** Waits for admitted active work and returns guidance if it still has not settled. */
export async function waitForPreparedReplyQueue(params: {
  activeSessionId: string;
  queueMode: QueueSettings["mode"];
  interruptActiveRun: () => Promise<boolean>;
  waitForActiveRunEnd: (sessionId: string) => Promise<unknown>;
  refreshPreparedState: () => Promise<void>;
  resolveBusyState: () => { isActive: boolean };
}): Promise<ReplyPayload | undefined> {
  await (params.queueMode === "interrupt"
    ? params.interruptActiveRun()
    : params.waitForActiveRunEnd(params.activeSessionId));
  await params.refreshPreparedState();
  return params.resolveBusyState().isActive
    ? { text: REPLY_RUN_STILL_SHUTTING_DOWN_TEXT }
    : undefined;
}
