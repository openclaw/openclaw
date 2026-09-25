// Resolves queue mode and admission policy for a reply turn.
import type { FollowupRun, QueueSettings } from "./queue.js";
import type { ReplyOperation } from "./reply-run-registry.js";

type ReplyQueueAdmissionState = "empty" | "steering" | "ready";

/** Separates waiting messages from the queued turn that already owns execution. */
export function resolveReplyQueueAdmissionState(
  queue:
    | { items: readonly FollowupRun[]; inFlight: ReadonlySet<FollowupRun>; droppedCount: number }
    | undefined,
  activeOperation: Pick<ReplyOperation, "turnKind" | "result"> | undefined,
): ReplyQueueAdmissionState {
  if (!queue) {
    return "empty";
  }
  const queuedTurnOwnsExecution =
    activeOperation?.turnKind === "queued_followup" && activeOperation.result === null;
  // Drains retain their sources until execution and delivery settle. Once that
  // drain owns the reply slot, those sources are the active turn, not a backlog.
  // Other waiting messages still keep FIFO priority over a new steer.
  return queue.items.some(
    (item) => !item.steerPending && !(queuedTurnOwnsExecution && queue.inFlight.has(item)),
  ) ||
    (!queuedTurnOwnsExecution && queue.inFlight.size > 0) ||
    queue.droppedCount > 0
    ? "ready"
    : "steering";
}

/** Queue decisions for messages that arrive while an agent run is active. */
export type ActiveRunQueueAction = "run-now" | "enqueue-followup" | "drop";

/** Resolves whether an active session should run, queue, or drop a new inbound turn. */
export function resolveActiveRunQueueAction(params: {
  queueAdmissionState?: ReplyQueueAdmissionState;
  isActive: boolean;
  isHeartbeat: boolean;
  shouldFollowup: boolean;
  queueMode: QueueSettings["mode"];
  resetTriggered?: boolean;
}): ActiveRunQueueAction {
  if (!params.isActive && (!params.queueAdmissionState || params.queueAdmissionState === "empty")) {
    return "run-now";
  }
  if (params.isHeartbeat) {
    return "drop";
  }
  if (params.resetTriggered) {
    return "run-now";
  }
  if (params.queueAdmissionState && params.queueAdmissionState !== "empty") {
    return "enqueue-followup";
  }
  // Follow-up queueing is only meaningful for non-heartbeat user turns.
  if (params.shouldFollowup) {
    return "enqueue-followup";
  }
  return "run-now";
}
