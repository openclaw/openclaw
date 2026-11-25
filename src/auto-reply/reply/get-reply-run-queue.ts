import type { ReplyPayload } from "../types.js";
import type { QueueSettings } from "./queue/types.js";

export const REPLY_RUN_STILL_SHUTTING_DOWN_TEXT =
  "⚠️ Previous run is still shutting down. Please try again in a moment.";
const REPLY_RUN_WRITER_FENCE_BLOCKED_TEXT =
  "⚠️ Previous run could not be safely retired because its writer is still active. Start a separate session or restart the Gateway before retrying this session.";

/** Waits for admitted active work and returns guidance if it still has not settled. */
export async function waitForPreparedReplyQueue(params: {
  activeSessionId: string;
  queueMode: QueueSettings["mode"];
  interruptActiveRun: () => Promise<boolean>;
  waitForActiveRunEnd: (sessionId: string) => Promise<unknown>;
  refreshPreparedState: () => Promise<void>;
  resolveBusyState: () => { isActive: boolean; terminalProducerBlocked?: boolean };
}): Promise<ReplyPayload | undefined> {
  if (params.queueMode === "interrupt") {
    // An idle run slot is not evidence that its former writer settled. In
    // particular a watchdog can release the slot while delivery still owns I/O.
    if (!(await params.interruptActiveRun())) {
      return { text: REPLY_RUN_STILL_SHUTTING_DOWN_TEXT };
    }
  } else {
    await params.waitForActiveRunEnd(params.activeSessionId);
  }
  await params.refreshPreparedState();
  const busy = params.resolveBusyState();
  return busy.isActive
    ? {
        text: busy.terminalProducerBlocked
          ? REPLY_RUN_WRITER_FENCE_BLOCKED_TEXT
          : REPLY_RUN_STILL_SHUTTING_DOWN_TEXT,
      }
    : undefined;
}
