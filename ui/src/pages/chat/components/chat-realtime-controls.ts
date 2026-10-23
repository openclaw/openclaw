import { persistedMessageEntryId } from "../chat-thread-items.ts";
import type { RealtimeTalkConversationEntry } from "../talk/conversation.ts";
import { createTranscriptMemo } from "./chat-transcript-memo.ts";

const persistedMessageIds = createTranscriptMemo<Set<string | null>>();

type ChatRealtimeTalkConversationProps = {
  assistantName: string;
  userName?: string | null;
  messages: readonly unknown[];
  realtimeTalkConversation?: RealtimeTalkConversationEntry[];
};

export function projectRealtimeTalkConversation(props: ChatRealtimeTalkConversationProps) {
  // Voice captions reconcile against unfiltered immutable history, not the
  // current search or streaming projection.
  const entries = (props.realtimeTalkConversation ?? []).filter((entry) => {
    if (!entry.transcriptId) {
      return true;
    }
    return !persistedMessageIds(
      props.messages,
      [],
      () => new Set(props.messages.map(persistedMessageEntryId)),
    ).has(entry.transcriptId);
  });
  return entries.length
    ? { assistantName: props.assistantName, userName: props.userName, entries }
    : null;
}
