import type { ChatQueueItem, MessageGroup } from "../../lib/chat/chat-types.ts";
import type { BuildChatItemsProps } from "./chat-thread-build.ts";

export function message(
  role: string,
  content: unknown,
  timestamp?: number,
  extra: object = {},
): Record<string, unknown> {
  return { role, content, ...(timestamp === undefined ? {} : { timestamp }), ...extra };
}

export function nativeMessage<C, M extends object>(
  role: string,
  content: C,
  timestamp: number,
  metadata: M,
  extra?: object,
) {
  return { role, content, timestamp, __openclaw: metadata, ...extra };
}

export const text = (value: string) => ({ type: "text", text: value });

export function signedText(value: string, phase: string, id = value) {
  return { ...text(value), textSignature: JSON.stringify({ v: 1, id, phase }) };
}

export function toolResult(
  toolCallId: string,
  toolName: string,
  content: unknown,
  timestamp: number,
  extra: object = {},
) {
  return message("toolResult", content, timestamp, { toolCallId, toolName, ...extra });
}

export function person(id: string, name = id) {
  return { senderId: id, senderName: name, senderIdentity: { type: "profile", id } };
}

export function queued(
  id: string,
  value: string,
  createdAt: number,
  sendState: ChatQueueItem["sendState"],
  extra: Partial<ChatQueueItem> = {},
): ChatQueueItem {
  return { id, text: value, createdAt, sendState, ...extra };
}

export function pending<M>(
  id: string,
  runId: string | undefined,
  value: M,
  acceptedAt: number,
  state: NonNullable<BuildChatItemsProps["pendingInputs"]>[number]["state"] = "queued",
) {
  return { id, runId, message: value, acceptedAt, state };
}

export function pendingText(
  content: string,
  acceptedAt: number,
  options: {
    id?: string;
    runId?: string;
    state?: Parameters<typeof pending>[4];
    message?: object;
  } = {},
) {
  const { id = content, runId = id, state, message: extra } = options;
  return pending(
    id,
    runId,
    nativeMessage("user", content, acceptedAt, { id: `pending:${id}` }, extra),
    acceptedAt,
    state,
  );
}

export function groupsOf<T extends { kind: string }>(items: readonly T[]) {
  return items.filter((item): item is Extract<T, { kind: "group" }> => item.kind === "group");
}

export function messagesOf(groups: readonly MessageGroup[]) {
  return groups.flatMap((group) => group.messages.map(({ message: value }) => value));
}
