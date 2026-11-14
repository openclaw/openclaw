import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { fnv1aUtf16 } from "../../../../src/shared/fnv1a.js";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { readChatThreadMessageIdentity } from "../../lib/chat/history-message-identity.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";

export function isPendingSendMessage(message: unknown): boolean {
  return asRecord(asRecord(message)?.["__openclaw"])?.kind === "pending-send";
}

export function persistedMessageEntryId(message: unknown): string | null {
  const id = readChatThreadMessageIdentity(message)?.id;
  return isPendingSendMessage(message) || id?.startsWith(CHAT_PENDING_INPUT_MESSAGE_PREFIX)
    ? null
    : (id ?? null);
}

export function transcriptMessageSourceKey(message: unknown): string | null {
  // Send identity outranks transcript ids: the same submit is re-projected with
  // different id/seq metadata across the pending -> history handoff, and a key
  // change there remounts the bubble (visible flicker).
  const identity = readChatThreadMessageIdentity(message);
  if (identity?.sendId) {
    return `send:${identity.sendId}`;
  }
  if (identity?.isImported) {
    if (identity.externalSource) {
      return `import:${identity.externalSource}`;
    }
    return identity.sequence === null ? null : `import-seq:${identity.sequence}`;
  }
  if (identity?.id) {
    return `id:${identity.id}`;
  }
  return identity?.sequence == null ? null : `seq:${identity.sequence}`;
}

const messageProjectionDigests = new WeakMap<object, string>();

function messageProjectionDigest(message: unknown): string {
  if (message && typeof message === "object") {
    const cached = messageProjectionDigests.get(message);
    if (cached) {
      return cached;
    }
  }
  const record = asRecord(message);
  const source = [
    typeof record?.role === "string" ? record.role : "",
    typeof record?.toolCallId === "string" ? record.toolCallId : "",
    record ? extractTextCached(message) : "",
  ].join("\u0000");
  const digest = `p${fnv1aUtf16(source).toString(36)}${source.length.toString(36)}`;
  if (message && typeof message === "object") {
    messageProjectionDigests.set(message, digest);
  }
  return digest;
}

export function buildMessageItems<Message>(
  messages: Message[],
  resolveSourceKey: (message: Message) => string | null = transcriptMessageSourceKey,
): Array<Extract<ChatItem, { kind: "message" }> & { message: Message }> {
  const sourceKeys = messages.map(resolveSourceKey);
  const sourceCounts = new Map<string, number>();
  for (const sourceKey of sourceKeys) {
    if (sourceKey) {
      sourceCounts.set(sourceKey, (sourceCounts.get(sourceKey) ?? 0) + 1);
    }
  }
  const projectionOccurrences = new Map<string, number>();
  return messages.map((message, index) => {
    const sourceKey = sourceKeys[index];
    const needsProjectionIdentity = sourceKey == null || (sourceCounts.get(sourceKey) ?? 0) > 1;
    const projectionKey = needsProjectionIdentity
      ? `${sourceKey ?? "legacy"}:projection:${messageProjectionDigest(message)}`
      : (sourceKey ?? "legacy");
    const occurrence = projectionOccurrences.get(projectionKey) ?? 0;
    projectionOccurrences.set(projectionKey, occurrence + 1);
    const record = asRecord(message);
    const callId = typeof record?.toolCallId === "string" ? record.toolCallId : "";
    const role = typeof record?.role === "string" ? record.role : "unknown";
    const transcriptKey = `${projectionKey}:${occurrence}`;
    return {
      kind: "message",
      key: callId ? `tool:${role}:${callId}:${transcriptKey}` : `msg:${transcriptKey}`,
      message,
    };
  });
}
