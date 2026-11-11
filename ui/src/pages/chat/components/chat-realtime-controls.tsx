import { For, Show } from "solid-js";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createParkedProjection } from "../../../lib/reactive/parked-projection.ts";
import { createDocumentVisibility } from "../../../lib/reactive/platform.ts";
import type { RealtimeTalkConversationEntry } from "../talk/conversation-state.ts";

registerEnglishCatalog(registerChatSessionEnglish);

registerEnglishCatalog(registerChatComposerEnglish);

export function RealtimeTalkConversation(props: {
  assistantName: string;
  userName?: string | null;
  entries: readonly RealtimeTalkConversationEntry[];
}) {
  const documentVisible = createDocumentVisibility();
  const entries = createParkedProjection(() => props.entries, documentVisible);
  return (
    <Show when={entries().length}>
      <div
        class="agent-chat__voice-turns"
        role="log"
        aria-label={t("chat.composer.voiceTranscript")}
      >
        <For each={entries()} keyed={(entry) => entry.id}>
          {(entry) => (
            // A caption is the message it becomes once saved: it shares the
            // message group and bubble styles so the handoff does not restyle it.
            <div
              class={[
                "chat-group",
                "agent-chat__voice-turn",
                {
                  user: entry().role === "user",
                  assistant: entry().role === "assistant",
                  "agent-chat__voice-turn--user": entry().role === "user",
                  "agent-chat__voice-turn--assistant": entry().role === "assistant",
                },
              ]}
              data-role={entry().role}
            >
              <div class="chat-group-messages">
                <div class="chat-bubble">
                  <span class="agent-chat__voice-turn-speaker sr-only">
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
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
