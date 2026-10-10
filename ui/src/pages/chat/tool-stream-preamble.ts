import { readAssistantStreamSegmentIdentity } from "@openclaw/gateway-client/browser";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isCompleteAgentPreamble } from "../../../../src/agents/agent-activity-presentation.js";
import { stripInlineDirectiveTagsForDelivery } from "../../../../src/utils/directive-tags.js";
import { reconcileChatRunStartup } from "./chat-run-startup.ts";
import { observedRunInputSendId } from "./stream-causal-boundary.ts";
import type { AgentEventPayload, ToolStreamHost } from "./tool-stream-contract.ts";
import { acceptsToolStreamSession } from "./tool-stream-status.ts";

function normalizePreambleProgressText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const stripped = stripInlineDirectiveTagsForDelivery(value)
    .text.replace(/^(?:[ \t]*\r?\n)+/u, "")
    .trimEnd();
  const normalized = stripped.replace(/^[\s*_`~]+|[\s*_`~]+$/gu, "").trim();
  return /^NO_REPLY$/iu.test(normalized) ? "" : stripped;
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
  const text = normalizePreambleProgressText(data.progressText);
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
  const existing = host.chatStreamSegments.find(
    (segment) => segment.itemId === itemId && segment.runId === payload.runId,
  );
  const persisted = host.chatMessages?.some((message) => {
    const identity = readAssistantStreamSegmentIdentity(message);
    return identity?.itemId === itemId && identity?.runId === payload.runId;
  });
  if (persisted || !text.trim()) {
    // Durable or empty commentary retires only its matching keyed live copy.
    host.chatStreamSegments = host.chatStreamSegments.filter(
      (segment) => segment.itemId !== itemId || segment.runId !== payload.runId,
    );
    return true;
  }
  if (existing) {
    host.chatStreamSegments = host.chatStreamSegments.map((segment) =>
      segment === existing
        ? {
            ...segment,
            text,
          }
        : segment,
    );
    return true;
  }
  host.chatStreamSegments = [
    ...host.chatStreamSegments,
    {
      text,
      ts: payload.ts,
      runId: payload.runId,
      itemId,
      afterUserSendId:
        source === "live" ? observedRunInputSendId(host.chatMessages, payload.runId) : undefined,
    },
  ];
  return true;
}
