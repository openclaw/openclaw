import {
  readSessionMessageIdentity,
  type SessionProjectionState,
} from "@openclaw/gateway-client/browser";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { extractThinkingCached } from "../../lib/chat/message-extract.ts";
import type { AgentEventPayload, ChatReasoning } from "./tool-stream-contract.ts";

export type ChatReasoningHost = { chatReasoning?: ChatReasoning | null };

function reconcilePersistedReasoning(host: ChatReasoningHost, messages: readonly unknown[]): void {
  const current = host.chatReasoning;
  const receipt = current?.receipt;
  if (!current || !receipt || receipt.persisted) {
    return;
  }
  if (
    messages.some((message) => {
      const identity = readSessionMessageIdentity(message);
      return (
        identity?.role === "assistant" &&
        !identity.isImported &&
        identity.runId === receipt.runId &&
        identity.id === receipt.messageId
      );
    })
  ) {
    host.chatReasoning = { ...current, receipt: { ...receipt, persisted: true } };
  }
}

export function updateChatReasoning(
  host: ChatReasoningHost & { chatMessages?: unknown[] },
  payload: AgentEventPayload,
): boolean {
  const itemId = normalizeNullableString(payload.data.itemId);
  if (!itemId) {
    return false;
  }
  const current = host.chatReasoning;
  const sameItem = current?.runId === payload.runId && current.itemId === itemId;
  if (payload.data.phase === "persisted") {
    const messageId = normalizeNullableString(payload.data.messageId);
    const messageRunId = normalizeNullableString(payload.data.messageRunId);
    if (!sameItem || !messageId || !messageRunId) {
      return false;
    }
    host.chatReasoning = { ...current, receipt: { runId: messageRunId, messageId } };
    reconcilePersistedReasoning(host, host.chatMessages ?? []);
    return true;
  }
  if (typeof payload.data.text !== "string") {
    return false;
  }
  const text = normalizeNullableString(payload.data.text);
  if (!text) {
    // Workers can replace a streamed draft with an empty final snapshot.
    host.chatReasoning = null;
    return Boolean(current);
  }
  host.chatReasoning = sameItem
    ? { ...current, text }
    : { runId: payload.runId, itemId, text, startedAt: payload.ts };
  return true;
}

/** Transfer only the still-live occurrence through the final answer's reducer entry. */
export function withChatReasoning(
  host: ChatReasoningHost,
  message: Record<string, unknown> | null,
  runId: string | undefined,
): Record<string, unknown> | null {
  const reasoning = host.chatReasoning;
  if (
    !message ||
    !reasoning ||
    reasoning.runId !== runId ||
    reasoning.receipt !== undefined ||
    extractThinkingCached(message)
  ) {
    return message;
  }
  const content = Array.isArray(message.content)
    ? message.content
    : [{ type: "text", text: message.content }];
  return { ...message, content: [{ type: "thinking", thinking: reasoning.text }, ...content] };
}

/** Only accepted transcript publication hands the preview to its exact saved occurrence. */
export function reconcileChatReasoning(
  host: ChatReasoningHost,
  projection: SessionProjectionState,
  previousMessages: readonly unknown[] | undefined,
): void {
  const current = host.chatReasoning;
  if (!current) {
    return;
  }
  const outcome = projection.runs[current.runId]?.status;
  // Successful finals first transfer thinking into their reducer-owned message.
  // Silent and interrupted terminals retire previews without fabricating replies.
  if (outcome !== undefined && outcome !== "streaming") {
    host.chatReasoning = null;
  } else if (previousMessages !== projection.messages) {
    reconcilePersistedReasoning(host, projection.messages);
  }
}

/** View preferences select one owner while a committed preview remains available to stream mode. */
export function projectChatReasoning(props: {
  showThinking: boolean;
  selectedSession?: { reasoningLevel?: string | null };
  reasoning?: ChatReasoning | null;
  runId?: string | null;
}) {
  const level = props.selectedSession?.reasoningLevel;
  const showReasoning = props.showThinking && level === "on";
  const reasoning = props.reasoning;
  const ownsPreview = !props.runId || props.runId === reasoning?.runId;
  const showPreview =
    props.showThinking &&
    ownsPreview &&
    ((level === "on" && !reasoning?.receipt?.persisted) || level === "stream");
  return { showReasoning, reasoning: showPreview ? reasoning : null };
}
