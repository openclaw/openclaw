import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { isSessionRunVisuallyActive } from "../../lib/session-run-state.ts";
import type { ChatRunStartupStatus } from "./chat-run-startup.ts";
import type { ChatRunUiStatus } from "./run-lifecycle.ts";

export function hasTerminalRunStatus(status: ChatRunUiStatus | null | undefined): boolean {
  return status?.phase === "done" || status?.phase === "interrupted";
}

export function isCurrentSessionSubmittedProgress(
  item: ChatQueueItem,
  sessionKey: string,
  status: ChatRunUiStatus | null | undefined,
): boolean {
  return (
    item.sessionKey === sessionKey &&
    !item.pendingRunId &&
    (item.sendState === "submitting" ||
      item.sendState === "sending" ||
      item.sendState === "waiting-model") &&
    (status == null || item.sendRunId !== status.runId)
  );
}

// Shared by the thread, composer, pane activity, and header presentation.
export function isChatRunWorking(props: {
  runActive?: boolean;
  runStatus?: ChatRunUiStatus | null;
  queue: readonly ChatQueueItem[];
  sessionKey: string;
  startupStatus?: ChatRunStartupStatus | null;
}): boolean {
  return isSessionRunVisuallyActive(
    (props.runActive === true && !hasTerminalRunStatus(props.runStatus)) ||
      props.queue.some((item) =>
        isCurrentSessionSubmittedProgress(item, props.sessionKey, props.runStatus),
      ),
    props.startupStatus?.phase,
  );
}
