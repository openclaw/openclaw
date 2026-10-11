import {
  readSessionMessageIdentity,
  type SessionProjectionState,
} from "@openclaw/gateway-client/browser";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { extractThinkingCached } from "../../lib/chat/message-extract.ts";
import type { AgentEventPayload, ChatReasoning } from "./tool-stream-contract.ts";

export type ChatReasoningHost = { chatReasoning?: ChatReasoning | null };

function reconcilePersistedReasoning(host: ChatReasoningHost, messages: readonly unknown[]): void {
  const reasoning = host.chatReasoning;
  if (!reasoning) {
    return;
  }
  const items = reasoning.items.map((item) => {
    const receipt = item.receipt;
    return receipt &&
      !receipt.persisted &&
      messages.some((message) => {
        const identity = readSessionMessageIdentity(message);
        return (
          identity?.role === "assistant" &&
          !identity.isImported &&
          identity.runId === receipt.runId &&
          identity.id === receipt.messageId
        );
      })
      ? { ...item, receipt: { ...receipt, persisted: true as const } }
      : item;
  });
  if (items.some((item, index) => item !== reasoning.items[index])) {
    host.chatReasoning = { ...reasoning, items };
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
  const items = host.chatReasoning?.runId === payload.runId ? host.chatReasoning.items : [];
  const index = items.findIndex((item) => item.itemId === itemId);
  const current = items[index];
  if (payload.data.phase === "persisted") {
    const messageId = normalizeNullableString(payload.data.messageId);
    const messageRunId = normalizeNullableString(payload.data.messageRunId);
    if (!current || !messageId || !messageRunId) {
      return false;
    }
    host.chatReasoning = {
      runId: payload.runId,
      items: items.with(index, { ...current, receipt: { runId: messageRunId, messageId } }),
    };
    reconcilePersistedReasoning(host, host.chatMessages ?? []);
    return true;
  }
  if (typeof payload.data.text !== "string") {
    return false;
  }
  // Keep an explicitly empty tail: clearing a worker draft must not promote
  // an earlier tool occurrence into the final answer's reasoning.
  const text = normalizeNullableString(payload.data.text) ?? "";
  const item = current ? { ...current, text } : { itemId, text, startedAt: payload.ts };
  host.chatReasoning = {
    runId: payload.runId,
    items: current ? items.with(index, item) : [...items, item],
  };
  return true;
}

export function activeChatReasoning(reasoning: ChatReasoning | null | undefined) {
  const current = reasoning?.items.at(-1);
  return current?.text && !current.receipt ? current : null;
}

/** Transfer only the still-live occurrence through the final answer's reducer entry. */
export function withChatReasoning(
  host: ChatReasoningHost,
  message: Record<string, unknown> | null,
  runId: string | undefined,
): Record<string, unknown> | null {
  const reasoning = activeChatReasoning(host.chatReasoning);
  if (
    !message ||
    !reasoning ||
    host.chatReasoning?.runId !== runId ||
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
  const showPreview = props.showThinking && ownsPreview && (level === "on" || level === "stream");
  return { showReasoning, reasoning: showPreview ? reasoning : null };
}
