import { readAssistantStreamSegmentIdentity } from "@openclaw/gateway-client/browser";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isCompleteAgentPreamble } from "../../../../src/agents/agent-activity-presentation.js";
import { stripInlineDirectiveTagsForDelivery } from "../../../../src/utils/directive-tags.js";
import { reconcileChatRunStartup } from "./chat-run-startup.ts";
import { observedRunInputSendId } from "./stream-causal-boundary.ts";
import type { AgentEventPayload, ToolStreamEntry, ToolStreamHost } from "./tool-stream-contract.ts";
import { acceptsToolStreamSession } from "./tool-stream-status.ts";

export function bindTextBeforeRootTool(host: ToolStreamHost, entry: ToolStreamEntry, end: unknown) {
  const { runId, toolCallId, startedAt: ts, afterUserSendId } = entry;
  const stream = host.chatStream;
  if (
    host.chatRunId === runId &&
    stream &&
    typeof end === "number" &&
    end > 0 &&
    end <= stream.length &&
    !host.chatStreamSegments.some(
      (part) =>
        !part.itemId &&
        part.runId === runId &&
        part.text.length >= end &&
        stream.startsWith(part.text),
    )
  ) {
    // Keep the cumulative reply intact. Only the native producer can identify a completed span before a call.
    host.chatStreamSegments = [
      ...host.chatStreamSegments,
      { text: stream.slice(0, end), ts, runId, toolCallId, afterUserSendId },
    ];
  }
  // Bind completed commentary to the next root call, not to nested work or
  // a replayed start that predates it. Saved call timestamps may be earlier.
  const introducesCall = (segment: (typeof host.chatStreamSegments)[number]) =>
    Boolean(segment.itemId) &&
    !segment.toolCallId &&
    segment.runId === runId &&
    (segment.afterUserSendId === undefined || segment.afterUserSendId === afterUserSendId) &&
    segment.ts <= ts;
  if (host.chatStreamSegments.some(introducesCall)) {
    host.chatStreamSegments = host.chatStreamSegments.map((segment) =>
      introducesCall(segment) ? { ...segment, toolCallId } : segment,
    );
  }
}

export function handlePreambleProgress(
  host: ToolStreamHost,
  payload: AgentEventPayload,
  source: "live" | "history" = "live",
): boolean {
  if (payload.stream !== "item") {
    return false;
  }
  const data = payload.data ?? {};
  if (data.kind !== "preamble") {
    return false;
  }
  const reportedItemId = normalizeOptionalString(data.itemId) ?? normalizeOptionalString(data.id);
  const progressText = data.progressText;
  const text =
    typeof progressText === "string"
      ? stripInlineDirectiveTagsForDelivery(progressText)
          .text.replace(/^(?:[ \t]*\r?\n)+/u, "")
          .trimEnd()
      : "";
  if (!text && !reportedItemId) {
    return false;
  }
  if (
    !isCompleteAgentPreamble({
      phase: typeof payload.data.phase === "string" ? payload.data.phase : undefined,
      progressText: text,
    })
  ) {
    return true;
  }
  // Preambles belong to the visible run; a sibling run must never replace,
  // clear, or persist its commentary into this transcript.
  if (!acceptsToolStreamSession(host, payload)) {
    return true;
  }
  if (text) {
    reconcileChatRunStartup(host, { state: "activity", runId: payload.runId, seq: payload.seq });
  }
  // An unkeyed preamble owns its event, independently of cumulative chat text.
  const itemId =
    reportedItemId ?? JSON.stringify(["openclaw-ui-preamble", payload.runId, payload.seq]);
  const parts = host.chatStreamSegments;
  const index = parts.findIndex(
    (segment) => segment.itemId === itemId && segment.runId === payload.runId,
  );
  const persisted = host.chatMessages?.some((message) => {
    const identity = readAssistantStreamSegmentIdentity(message);
    return identity?.itemId === itemId && identity.runId === payload.runId;
  });
  if (persisted || !text) {
    if (index >= 0) {
      host.chatStreamSegments = parts.toSpliced(index, 1);
    }
  } else if (parts[index]) {
    host.chatStreamSegments = parts.with(index, { ...parts[index], text });
  } else {
    host.chatStreamSegments = [
      ...parts,
      {
        text,
        ts: payload.ts,
        runId: payload.runId,
        itemId,
        afterUserSendId:
          source === "live" ? observedRunInputSendId(host.chatMessages, payload.runId) : undefined,
      },
    ];
  }
  return true;
}
