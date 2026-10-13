import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../../../i18n/index.ts";
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

export function renderRealtimeTalkConversation(props: ChatRealtimeTalkConversationProps) {
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
  if (entries.length === 0) {
    return nothing;
  }
  return html`
    <div
      class="agent-chat__voice-turns"
      role="log"
      aria-label=${t("chat.composer.voiceTranscript")}
    >
      ${repeat(
        entries,
        (entry) => entry.id,
        (entry) => {
          const label =
            entry.role === "user" ? props.userName?.trim() || "You" : props.assistantName;
          return html`
            <div
              class="agent-chat__voice-turn agent-chat__voice-turn--${entry.role}"
              data-role=${entry.role}
            >
              <span class="agent-chat__voice-turn-speaker">${label}</span>
              <span class="agent-chat__voice-turn-text">${entry.text}</span>
              ${
                entry.isStreaming
                  ? html`<span
                      class="agent-chat__voice-turn-stream"
                      aria-label=${t("chat.composer.stillListening")}
                    ></span>`
                  : nothing
              }
            </div>
          `;
        },
      )}
    </div>
  `;
}
