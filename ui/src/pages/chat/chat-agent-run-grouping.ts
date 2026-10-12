import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import {
  assistantMessageIsInterrupted,
  resolveAssistantReplyPhase,
} from "./chat-assistant-reply.ts";
import {
  groupEndsRunInFailure,
  joinActivityRuns,
  type ActivityRunRenderItem,
  type CompletedTurnRenderItem,
  type StreamRunRenderItem,
  type WorkGroupRenderItem,
} from "./chat-thread-grouping.ts";
import {
  chatItemStartsDisplayTurn,
  chatItemStartsUserTurn,
  hasForwardedSource,
} from "./chat-turn-boundary.ts";
import { extractMessageMediaText } from "./components/chat-message-media.ts";

type AgentRunFramePart =
  | MessageGroup
  | WorkGroupRenderItem
  | ActivityRunRenderItem
  | StreamRunRenderItem;

export type AgentRunFrameRenderItem = {
  kind: "agent-run-frame";
  key: string;
  runId: string;
  boundaryId: string;
  outcome:
    | { kind: "active" }
    | { kind: "completed"; actionOwner: MessageGroup["messages"][number] | null }
    | { kind: "failed" };
  parts: AgentRunFramePart[];
};

type AgentRunFrameInput = CompletedTurnRenderItem | ActivityRunRenderItem;

export function chatItemGroups(item: AgentRunFrameInput | AgentRunFrameRenderItem): MessageGroup[] {
  if (item.kind === "agent-run-frame") {
    return item.parts.flatMap(chatItemGroups);
  }
  if (item.kind === "group") {
    return [item];
  }
  if (item.kind === "work-group" || item.kind === "activity-run") {
    return item.groups;
  }
  return [];
}

function itemRunId(item: AgentRunFramePart): string | undefined {
  if (item.kind === "work-group") {
    if (item.replyRunId) {
      return item.replyRunId;
    }
    // Matching execution IDs cannot erase a forwarded presentation boundary.
    if (item.groups.some(hasForwardedSource)) {
      return undefined;
    }
  }
  if (item.kind === "stream-run") {
    return item.runId;
  }
  const groups = chatItemGroups(item);
  const runId = groups[0]?.runId;
  return runId && groups.every((group) => group.runId === runId) ? runId : undefined;
}

function itemIsActive(item: AgentRunFramePart): boolean {
  if (item.kind === "stream-run") {
    return item.parts.some(
      (part) => part.kind === "reading-indicator" || (part.kind === "stream" && part.isStreaming),
    );
  }
  return chatItemGroups(item).some((group) => group.isStreaming);
}

function groupBoundaryId(group: MessageGroup): string | undefined {
  const firstMessage = group.messages[0]?.message;
  const identity = readSessionMessageIdentity(firstMessage);
  const runId = identity?.runId;
  if (runId) {
    return `send:${runId}`;
  }
  return identity?.id ? `entry:${identity.id}` : undefined;
}

function frameKey(runId: string, boundaryId: string, segmentId: string | undefined): string {
  return `agent-run:${JSON.stringify(segmentId ? [runId, boundaryId, segmentId] : [runId, boundaryId])}`;
}

function messageCanOwnCompletedFrame(message: unknown, explicitOnly: boolean): boolean {
  const record = asRecord(message);
  const phase = resolveAssistantReplyPhase(message);
  const stopReason = record?.stopReason;
  const metadata = asRecord(record?.["__openclaw"]);
  if (
    !(extractTextCached(message)?.trim() || extractMessageMediaText(message)) ||
    assistantMessageIsInterrupted(message) ||
    phase === "commentary" ||
    stopReason === "toolUse" ||
    stopReason === "error" ||
    (metadata?.mirrorOrigin === "codex-app-server" && metadata.runTerminal !== true)
  ) {
    return false;
  }
  return !explicitOnly || phase === "final_answer" || stopReason === "stop";
}

function completedFrameActionOwner(
  parts: AgentRunFramePart[],
): MessageGroup["messages"][number] | null {
  const messages = parts
    .flatMap(chatItemGroups)
    .flatMap((group) => (group.role === "assistant" ? group.messages : []));
  const explicit = messages.findLast(({ message }) => messageCanOwnCompletedFrame(message, true));
  if (explicit) {
    return explicit;
  }
  const lastPart = parts.at(-1);
  if (lastPart?.kind !== "group" || lastPart.role !== "assistant") {
    return null;
  }
  const last = lastPart.messages.at(-1);
  return last && messageCanOwnCompletedFrame(last.message, false) ? last : null;
}

export function agentRunFrameActiveStatusParts(
  frame: AgentRunFrameRenderItem,
): StreamRunRenderItem["parts"] | undefined {
  if (frame.outcome.kind !== "active") {
    return undefined;
  }
  const parts = frame.parts.flatMap((part) => (part.kind === "stream-run" ? part.parts : []));
  return parts.length > 0 &&
    frame.parts.every(
      (part) =>
        part.kind === "stream-run" &&
        part.parts.every((streamPart) => streamPart.kind === "reading-indicator"),
    )
    ? parts
    : undefined;
}

/** Wrap semantic work/activity rows in one run-owned presentation frame. */
export function coalesceAgentRunFrames(
  items: AgentRunFrameInput[],
  opts: { searchActive?: boolean } = {},
): Array<AgentRunFrameInput | AgentRunFrameRenderItem> {
  if (opts.searchActive) {
    return items;
  }
  const result: Array<AgentRunFrameInput | AgentRunFrameRenderItem> = [];
  let boundaryId: string | undefined;
  let presentationBoundaryKey: string | undefined;
  const emittedFrameKeys = new Set<string>();
  let segmentId: string | undefined;
  let runId: string | undefined;
  let parts: AgentRunFramePart[] = [];
  // A run that resumes a handoff continues the open frame: one answer, one
  // footer. The frame keeps the identity it opened with, so resuming reuses its
  // row; `resuming` lets exactly the next run in.
  let opened: { runId: string; boundaryId: string | undefined } | undefined;
  let resuming = false;
  // No row marks a handoff, so operations on either side of one are one log.
  let afterHandoff = false;
  const addPart = (item: AgentRunFramePart) => {
    const last = parts.at(-1);
    const joined = afterHandoff && last ? joinActivityRuns(last, item) : undefined;
    afterHandoff = false;
    if (joined) {
      parts[parts.length - 1] = joined;
    } else {
      parts.push(item);
    }
  };
  const flush = (failed = false) => {
    const frameRunId = opened?.runId ?? runId;
    const openedBoundaryId = opened ? opened.boundaryId : boundaryId;
    opened = undefined;
    resuming = false;
    afterHandoff = false;
    if (!runId || !frameRunId || parts.length === 0) {
      return;
    }
    const active = parts.some(itemIsActive);
    const actionOwner = active || failed ? null : completedFrameActionOwner(parts);
    if (!openedBoundaryId && !active && !actionOwner) {
      result.push(...parts);
      parts = [];
      runId = undefined;
      return;
    }
    // A history window can start inside a known run. This frame-local identity
    // supplies no prompt/recipient facts and must not leak into the next run.
    const frameBoundaryId = openedBoundaryId ?? `send:${frameRunId}`;
    const frameSegmentId =
      segmentId ??
      parts
        .flatMap((part) => (part.kind === "stream-run" ? part.parts : []))
        .find((part) => part.kind === "stream" && part.key.includes(":after:"))?.key;
    const semanticKey = frameKey(frameRunId, frameBoundaryId, frameSegmentId);
    // A peer input can split one causal run into separate presentation rows.
    // Reopening it must not reuse the earlier row’s DOM or measured height.
    const key = emittedFrameKeys.has(semanticKey)
      ? frameKey(
          frameRunId,
          frameBoundaryId,
          JSON.stringify([presentationBoundaryKey, parts[0]!.key]),
        )
      : semanticKey;
    emittedFrameKeys.add(semanticKey);
    result.push({
      kind: "agent-run-frame",
      key,
      runId,
      boundaryId: frameBoundaryId,
      outcome: failed
        ? { kind: "failed" }
        : active
          ? { kind: "active" }
          : { kind: "completed", actionOwner },
      parts,
    });
    parts = [];
    runId = undefined;
  };
  for (const item of items) {
    if (item.kind === "notice" && item.handoffBoundary && runId && parts.length > 0) {
      opened ??= { runId, boundaryId };
      resuming = true;
      afterHandoff = true;
      continue;
    }
    if (
      item.kind !== "group" &&
      item.kind !== "work-group" &&
      item.kind !== "activity-run" &&
      item.kind !== "stream-run"
    ) {
      flush();
      result.push(item);
      boundaryId = item.kind === "notice" && item.startsTurn ? item.boundaryId : undefined;
      segmentId = boundaryId ? undefined : item.key;
      continue;
    }
    const boundaryGroup = chatItemGroups(item)[0];
    if (boundaryGroup && chatItemStartsDisplayTurn(boundaryGroup)) {
      flush();
      presentationBoundaryKey = boundaryGroup.key;
      segmentId = undefined;
      const nextBoundaryId = groupBoundaryId(boundaryGroup);
      if (boundaryGroup.role === "user" || hasForwardedSource(boundaryGroup) || !nextBoundaryId) {
        result.push(item);
        boundaryId = nextBoundaryId;
        continue;
      }
      boundaryId = nextBoundaryId;
    }
    const candidateBoundaryId = item.kind === "stream-run" ? item.boundaryId : undefined;
    const candidateRunId = itemRunId(item);
    if (resuming && !candidateRunId && item.kind === "stream-run" && !candidateBoundaryId) {
      // The resumed run can be working before the pane learns its run id. Its
      // status belongs here already, so the block does not split and rejoin.
      addPart(item);
      continue;
    }
    if (resuming && candidateRunId && candidateRunId !== runId) {
      // Rows the handing-off run recorded after its handoff call still belong to
      // it. Once the next run arrives, later parts compare against that run.
      boundaryId = candidateBoundaryId;
      runId = candidateRunId;
      resuming = false;
    }
    if (candidateBoundaryId) {
      const effectiveBoundaryId = boundaryId ?? (runId ? `send:${runId}` : undefined);
      if (candidateBoundaryId !== effectiveBoundaryId) {
        flush();
      }
      boundaryId = candidateBoundaryId;
    }
    if (!candidateRunId) {
      flush();
      result.push(item);
      if (item.kind === "activity-run") {
        // A mixed-run log owns no frame, but does not end its surrounding turn.
        // Retain the latest projected boundary for subsequent replies and status.
        const lastBoundary = item.groups.findLast(chatItemStartsUserTurn);
        if (lastBoundary) {
          boundaryId = groupBoundaryId(lastBoundary);
          presentationBoundaryKey = lastBoundary.key;
          segmentId = undefined;
        } else if (item.groups.some((group) => group.runId === undefined)) {
          boundaryId = undefined;
          segmentId = item.key;
        }
      } else {
        boundaryId = undefined;
        segmentId = item.key;
      }
      continue;
    }
    // A later reply owns completed work; recovered failures remain in the log,
    // while the reply itself determines its frame’s terminal outcome.
    const failed =
      !(item.kind === "work-group" && item.replyRunId) &&
      chatItemGroups(item).some(groupEndsRunInFailure);
    if (runId && runId !== candidateRunId) {
      flush();
    }
    runId = candidateRunId;
    addPart(item);
    if (failed) {
      flush(true);
      boundaryId = undefined;
      segmentId = item.key;
    }
  }
  flush();
  return result;
}
