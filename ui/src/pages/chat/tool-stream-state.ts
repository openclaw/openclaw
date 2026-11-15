import { readToolStreamCanvasPreview } from "../../lib/chat/tool-cards.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import type { ToolStreamEntry, ToolStreamState } from "./tool-stream-contract.ts";
import { buildToolStreamIdentity } from "./tool-stream-identity.ts";

export function refreshToolStreamMessage(entry: ToolStreamEntry) {
  const itemEnded = entry.activity?.some(
    (item) =>
      (item.toolCallId ?? item.itemId) === entry.toolCallId &&
      item.phase === "end" &&
      !item.suppressChannelProgress,
  );
  const content: Array<Record<string, unknown>> = [];
  content.push({
    type: "toolcall",
    name: entry.name,
    arguments: entry.args ?? {},
    ...(entry.parentToolCallId ? { parentToolCallId: entry.parentToolCallId } : {}),
    ...(entry.details !== undefined ? { details: entry.details } : {}),
  });
  // Emit the result block whenever a result landed, even with empty output;
  // otherwise a completed no-stdout command keeps its running state in the UI.
  if (entry.output || entry.resultReceived) {
    content.push({
      type: "toolresult",
      name: entry.name,
      text: entry.output ?? "",
      ...(entry.parentToolCallId ? { parentToolCallId: entry.parentToolCallId } : {}),
      ...(entry.details !== undefined ? { details: entry.details } : {}),
      ...(entry.isError !== undefined ? { isError: entry.isError } : {}),
      ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
    });
  }
  entry.message = {
    role: "assistant",
    toolCallId: entry.toolCallId,
    runId: entry.runId,
    ...(entry.activity ? { activity: entry.activity } : {}),
    content,
    timestamp: entry.startedAt,
    // Running-state markers: only live tool-stream cards may show a spinner,
    // and completion comes from a result or live item end, never partial output
    // or a status-less history placeholder. Transcript messages never carry these,
    // so historical output-less calls (aborted runs) stay inert.
    __openclawToolStreamLive: true,
    __openclawToolStreamResultReceived: entry.resultReceived === true,
    __openclawToolStreamItemEnded: itemEnded === true,
    ...(entry.resultReceived !== true && !itemEnded && entry.liveOutput
      ? { __openclawToolStreamLiveOutput: entry.liveOutput }
      : {}),
    ...(entry.resultReceived !== true && !itemEnded && entry.liveDiffStat
      ? { __openclawToolStreamDiffStat: entry.liveDiffStat }
      : {}),
    __openclawToolStreamReceivedAt: entry.receivedAt,
    ...(entry.afterUserSendId ? { openclawToolStreamAfterSendId: entry.afterUserSendId } : {}),
  };
  entry.messageDirty = undefined;
}

export function syncToolStreamMessages(host: ToolStreamState, structureChanged = true) {
  let presentationChanged = structureChanged;
  const previous = host.chatToolMessages;
  const messages: Record<string, unknown>[] = [];
  const changedTools: string[] = [];
  const addPreviousIdentity = (message: Record<string, unknown> | undefined) => {
    if (typeof message?.runId === "string" && typeof message.toolCallId === "string") {
      changedTools.push(buildToolStreamIdentity(message.runId, message.toolCallId));
    }
  };
  for (const identity of host.toolStreamOrder) {
    const entry = host.toolStreamById.get(identity);
    if (entry?.messageDirty) {
      refreshToolStreamMessage(entry);
    }
    const message = entry?.message;
    if (!message) {
      continue;
    }
    const before = previous[messages.length];
    messages.push(message);
    if (message === before) {
      continue;
    }
    addPreviousIdentity(before);
    changedTools.push(identity);
    // Canvas output also changes conversation structure, unlike command stdout.
    presentationChanged ||= Boolean(
      readToolStreamCanvasPreview(before) || readToolStreamCanvasPreview(message),
    );
  }
  for (let index = messages.length; index < previous.length; index++) {
    addPreviousIdentity(previous[index]);
  }
  host.toolStreamStructureChanged = undefined;
  host.toolStreamPublishedAt = messages.length > 0 ? performance.now() : undefined;
  chatRunPresentation(host).publishToolMessages(messages, presentationChanged, changedTools);
}

export function cancelToolStreamSync(host: Pick<ToolStreamState, "toolStreamSyncTimer">) {
  if (host.toolStreamSyncTimer != null) {
    clearTimeout(host.toolStreamSyncTimer);
    host.toolStreamSyncTimer = null;
  }
}

/** Captured partial cards may survive a terminal event; their live tails must not. */
export function retireToolStreamLiveOutput(host: ToolStreamState, runId: string) {
  let changed = false;
  for (const entry of host.toolStreamById.values()) {
    if (entry.runId === runId && entry.liveOutput) {
      entry.liveOutput = undefined;
      entry.messageDirty = true;
      changed = true;
    }
  }
  if (changed) {
    syncToolStreamMessages(host);
  }
}

export function resetToolStream(
  host: ToolStreamState,
  options?: { preserveStreamSegments?: boolean },
) {
  cancelToolStreamSync(host);
  host.toolStreamPublishedAt = undefined;
  host.toolStreamStructureChanged = undefined;
  host.toolStreamById.clear();
  host.toolStreamOrder = [];
  host.activityEventSeqById?.clear();
  host.chatToolMessages = [];
  if (!options?.preserveStreamSegments) {
    host.chatStreamSegments = [];
  }
  host.knownAgentRunIds?.clear();
  host.waitingApprovalStatuses?.clear();
  // Resolution can beat the overlay queue update. Keep tombstones across transient stream resets
  // until snapshot reconciliation observes the approval leaving the queue.
}

export function resetToolStreamRun(host: ToolStreamState, runId: string) {
  cancelToolStreamSync(host);
  host.toolStreamOrder = host.toolStreamOrder.filter((identity) => {
    if (host.toolStreamById.get(identity)?.runId !== runId) {
      return true;
    }
    host.toolStreamById.delete(identity);
    return false;
  });
  const activityPrefix = `tool:[${JSON.stringify(runId)},`;
  for (const sequenceIdentity of host.activityEventSeqById?.keys() ?? []) {
    if (
      sequenceIdentity.startsWith(activityPrefix) ||
      sequenceIdentity.startsWith(`item:${runId}:`)
    ) {
      host.activityEventSeqById?.delete(sequenceIdentity);
    }
  }
  syncToolStreamMessages(host);
  host.chatStreamSegments = host.chatStreamSegments.filter((segment) => segment.runId !== runId);
  host.knownAgentRunIds?.delete(runId);
  for (const [approvalId, waitingApproval] of host.waitingApprovalStatuses ?? []) {
    if (waitingApproval.runId === runId) {
      host.waitingApprovalStatuses?.delete(approvalId);
    }
  }
}
