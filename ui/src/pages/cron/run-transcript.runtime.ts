import type { CronHistoryResult } from "@openclaw/gateway-protocol";
import { readChatThreadMessageIdentity } from "../../lib/chat/history-message-identity.ts";
import { visibleChatHistoryMessages } from "../../lib/chat/message-visibility.ts";
import { attachHistoryActivity } from "../chat/chat-history-request.ts";

export { ChatHistoryBoundary } from "../chat/components/chat-history-boundary.tsx";

function transcriptEntryKey(message: unknown): string | undefined {
  const identity = readChatThreadMessageIdentity(message);
  if (!identity) {
    return undefined;
  }
  return identity.externalSource
    ? `external:${identity.externalSource}`
    : identity.id
      ? `id:${identity.id}`
      : identity.sequence == null
        ? undefined
        : `seq:${identity.sequence}`;
}

export function prepareCronRunTranscriptMessages(result: CronHistoryResult, later?: unknown[]) {
  const messages = visibleChatHistoryMessages(attachHistoryActivity(result).messages);
  if (!later) {
    return messages;
  }
  const laterKeys = new Set(later.map(transcriptEntryKey).filter(Boolean));
  const overlap = messages.findIndex((message) => {
    const key = transcriptEntryKey(message);
    return key !== undefined && laterKeys.has(key);
  });
  // The newer page owns whole overlapping entries, including projected siblings.
  return [...messages.slice(0, overlap < 0 ? messages.length : overlap), ...later];
}
