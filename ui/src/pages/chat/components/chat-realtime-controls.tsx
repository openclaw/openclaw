import { For, Show } from "solid-js";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { RealtimeTalkConversationEntry } from "../talk/conversation.ts";

registerEnglishCatalog(registerChatComposerEnglish);

export function RealtimeTalkConversation(props: {
  assistantName: string;
  userName?: string | null;
  entries: readonly RealtimeTalkConversationEntry[];
}) {
  return (
    <Show when={props.entries.length}>
      <div
        class="agent-chat__voice-turns"
        role="log"
        aria-label={t("chat.composer.voiceTranscript")}
      >
        <For each={props.entries} keyed={(entry) => entry.id}>
          {(entry) => (
            <div
              class={[
                "agent-chat__voice-turn",
                {
                  "agent-chat__voice-turn--user": entry().role === "user",
                  "agent-chat__voice-turn--assistant": entry().role === "assistant",
                },
              ]}
              data-role={entry().role}
            >
              <span class="agent-chat__voice-turn-speaker">
                {entry().role === "user"
                  ? props.userName?.trim() || t("chat.reactions.you")
                  : props.assistantName}
              </span>{" "}
              <span class="agent-chat__voice-turn-text">{entry().text}</span>
              {entry().isStreaming ? (
                <span
                  class="agent-chat__voice-turn-stream"
                  aria-label={t("chat.composer.stillListening")}
                />
              ) : undefined}
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
