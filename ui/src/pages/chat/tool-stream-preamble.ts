import { readAssistantStreamSegmentIdentity } from "@openclaw/gateway-client/browser";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isCompleteAgentPreamble } from "../../../../src/agents/agent-activity-presentation.js";
import { stripInlineDirectiveTagsForDelivery } from "../../../../src/utils/directive-tags.js";
import { reconcileChatRunStartup } from "./chat-run-startup.ts";
import type { AgentEventPayload, ToolStreamHost } from "./tool-stream-contract.ts";
import { acceptsToolStreamSession } from "./tool-stream-status.ts";

function readPreambleProgressEvent(
  payload: AgentEventPayload,
): { text: string; itemId?: string } | null {
  if (payload.stream !== "item") {
    return null;
  }
  const data = payload.data ?? {};
  if (data.kind !== "preamble") {
    return null;
  }
  const itemId = normalizeOptionalString(data.itemId) ?? normalizeOptionalString(data.id);
  const progressText = normalizePreambleProgressText(data.progressText);
  if (!progressText && !itemId) {
    return null;
  }
  return {
    text: progressText,
    ...(itemId ? { itemId } : {}),
  };
}

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

export function handlePreambleProgress(host: ToolStreamHost, payload: AgentEventPayload): boolean {
  const progress = readPreambleProgressEvent(payload);
  if (!progress) {
    return false;
  }
  if (
    !isCompleteAgentPreamble({
      phase: typeof payload.data.phase === "string" ? payload.data.phase : undefined,
      progressText: progress.text,
    })
  ) {
    return true;
  }
  // Preambles belong to the visible run; a sibling run must never replace,
  // clear, or persist its commentary into this transcript.
  if (!acceptsToolStreamSession(host, payload)) {
    return true;
  }
  if (progress.text) {
    reconcileChatRunStartup(host, { state: "activity", runId: payload.runId, seq: payload.seq });
  }
  // An unkeyed preamble owns its event, independently of cumulative chat text.
  const itemId =
    progress.itemId ?? JSON.stringify(["openclaw-ui-preamble", payload.runId, payload.seq]);
  const existing = host.chatStreamSegments.find(
    (segment) => segment.itemId === itemId && segment.runId === payload.runId,
  );
  const persisted = host.chatMessages?.some((message) => {
    const identity = readAssistantStreamSegmentIdentity(message);
    return identity?.itemId === itemId && identity?.runId === payload.runId;
  });
  if (persisted || !progress.text.trim()) {
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
            text: progress.text,
          }
        : segment,
    );
    return true;
  }
  host.chatStreamSegments = [
    ...host.chatStreamSegments,
    {
      text: progress.text,
      ts: payload.ts,
      runId: payload.runId,
      itemId,
    },
  ];
  return true;
}
