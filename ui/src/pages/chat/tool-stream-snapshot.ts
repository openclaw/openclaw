import { normalizeNullableString as toTrimmedString } from "@openclaw/normalization-core/string-coerce";
import type { ExecApprovalRequest } from "../../app/exec-approval.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { uiSessionEventMatches } from "../../lib/sessions/session-key.ts";
import type { ToolStreamHost } from "./tool-stream-contract.ts";

export function resolveChatProjectionRunId(params: {
  localRunId?: string | null;
  activeRunIds?: readonly string[];
  queue?: readonly ChatQueueItem[];
}): string | null {
  if (params.localRunId) {
    return params.localRunId;
  }
  const activeRunIds = new Set(params.activeRunIds ?? []);
  // A session row can lag local completion. Restore its run identity only when
  // the durable outbox independently proves that the same send is reconnecting.
  return (
    params.queue?.find(
      (item) =>
        item.sendState === "waiting-reconnect" &&
        typeof item.sendRunId === "string" &&
        activeRunIds.has(item.sendRunId),
    )?.sendRunId ?? null
  );
}

type WaitingApprovalSnapshotHost = Pick<
  ToolStreamHost,
  | "sessionKey"
  | "assistantAgentId"
  | "agentsList"
  | "hello"
  | "knownAgentRunIds"
  | "waitingApprovalStatuses"
  | "waitingApprovalResolvedIds"
>;

export function reconcileWaitingApprovalsFromSnapshot(
  host: WaitingApprovalSnapshotHost,
  queue: readonly ExecApprovalRequest[],
): boolean {
  const waiting = (host.waitingApprovalStatuses ??= new Map());
  const resolvedIds = (host.waitingApprovalResolvedIds ??= new Set());
  const allQueuedIds = new Set(queue.map((approval) => approval.id));
  for (const approvalId of resolvedIds) {
    if (!allQueuedIds.has(approvalId)) {
      resolvedIds.delete(approvalId);
    }
  }
  const matchingApprovals = queue.filter(
    (approval) =>
      approval.kind === "exec" &&
      approval.request.sessionKey &&
      uiSessionEventMatches(host, approval.request.sessionKey, approval.request.agentId),
  );
  const queuedIds = new Set(matchingApprovals.map((approval) => approval.id));
  let changed = false;
  for (const approvalId of waiting.keys()) {
    if (!queuedIds.has(approvalId)) {
      waiting.delete(approvalId);
      changed = true;
    }
  }
  if (waiting.size > 0) {
    return changed;
  }
  // On a fresh mount the inline approval card still exposes the parked request in the transcript.
  // Spinner-label hydration across mounts needs an authoritative Gateway run-state contract and
  // is deliberately deferred.
  for (const approval of matchingApprovals) {
    const runId = toTrimmedString(approval.request.runId);
    if (!runId || !host.knownAgentRunIds?.has(runId) || resolvedIds.has(approval.id)) {
      continue;
    }
    waiting.set(approval.id, {
      runId,
    });
    changed = true;
  }
  return changed;
}
