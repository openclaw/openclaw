import type { TalkVoiceSelection } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { renderPicker } from "../../../components/select-picker.ts";
import { t } from "../../../i18n/index.ts";
import type { RealtimeTalkConversationEntry } from "../talk/conversation.ts";

type ChatRealtimeTalkConversationProps = {
  assistantName: string;
  userName?: string | null;
  realtimeTalkConversation?: RealtimeTalkConversationEntry[];
};

export function renderRealtimeVoicePicker(params: {
  selection?: TalkVoiceSelection | null;
  changing?: boolean;
  disabled?: boolean;
  onChange?: (voice: string) => void;
}) {
  const { selection } = params;
  if (!selection || !params.onChange) {
    return nothing;
  }
  const options = selection.voices.map((value) => ({ value, label: value }));
  return html`<span class="chat-talk-voice-picker" aria-busy=${String(Boolean(params.changing))}>
    ${renderPicker({
      label: t("talkPage.voice.title"),
      value: selection.voice ?? "",
      options: [
        ...(!selection.voice
          ? [{ value: "", label: t("talkPage.voice.default"), disabled: true }]
          : []),
        ...options,
        ...(selection.voice && !selection.voices.includes(selection.voice)
          ? [{ value: selection.voice, label: selection.voice, disabled: true }]
          : []),
      ],
      disabled: params.disabled || params.changing || !selection.canChange,
      title: params.changing ? t("chat.voice.preparing") : t("talkPage.voice.title"),
      placement: "top",
      searchable: true,
      onChange: params.onChange,
    })}
  </span>`;
}

export function renderRealtimeTalkConversation(props: ChatRealtimeTalkConversationProps) {
  const entries = props.realtimeTalkConversation ?? [];
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
