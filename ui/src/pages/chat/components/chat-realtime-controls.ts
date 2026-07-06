import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../../../i18n/index.ts";
import type { RealtimeTalkConversationEntry } from "../realtime-talk-conversation.ts";

type TalkSelectOption = { label: string; value: string };

const TALK_VOICE_OPTIONS: TalkSelectOption[] = [
  { label: "Default", value: "" },
  { label: "Alloy", value: "alloy" },
  { label: "Ash", value: "ash" },
  { label: "Ballad", value: "ballad" },
  { label: "Coral", value: "coral" },
  { label: "Echo", value: "echo" },
  { label: "Sage", value: "sage" },
  { label: "Shimmer", value: "shimmer" },
  { label: "Verse", value: "verse" },
  { label: "Marin", value: "marin" },
  { label: "Cedar", value: "cedar" },
];
const TALK_SENSITIVITY_OPTIONS: TalkSelectOption[] = [
  { label: "Default", value: "" },
  { label: "Low", value: "0.65" },
  { label: "Medium", value: "0.5" },
  { label: "High", value: "0.35" },
];
export type RealtimeTalkOptions = {
  model: string;
  voice: string;
  vadThreshold: string;
};

type ChatRealtimeTalkOptionsProps = {
  realtimeTalkOptionsOpen?: boolean;
  realtimeTalkOptions?: RealtimeTalkOptions;
  onRealtimeTalkOptionsChange?: (next: Partial<RealtimeTalkOptions>) => void;
  canOpenRealtimeTalkSettings?: boolean;
  onOpenRealtimeTalkSettings?: () => void;
};

type ChatRealtimeTalkConversationProps = {
  assistantName: string;
  userName?: string | null;
  realtimeTalkConversation?: RealtimeTalkConversationEntry[];
};

function renderNativeTalkSelect(params: {
  label: string;
  value: string;
  options: TalkSelectOption[];
  onSelect: (value: string) => void;
}) {
  return html`
    <label class="agent-chat__talk-field" data-talk-select=${params.label.toLowerCase()}>
      <span>${params.label}</span>
      <select
        .value=${params.value}
        @change=${(event: Event) =>
          params.onSelect((event.currentTarget as HTMLSelectElement).value)}
      >
        ${repeat(
          params.options,
          (entry) => entry.value,
          (entry) => html`
            <option
              value=${entry.value}
              data-talk-select-option=${entry.value}
              ?selected=${entry.value === params.value}
              @click=${() => params.onSelect(entry.value)}
            >
              ${entry.label}
            </option>
          `,
        )}
      </select>
    </label>
  `;
}

export function renderRealtimeTalkOptions(props: ChatRealtimeTalkOptionsProps) {
  const options = props.realtimeTalkOptions;
  const onChange = props.onRealtimeTalkOptionsChange;
  if (!props.realtimeTalkOptionsOpen || !options || !onChange) {
    return nothing;
  }
  return html`
    <div class="agent-chat__talk-options" aria-label="Talk options">
      <div class="agent-chat__talk-options-primary">
        ${renderNativeTalkSelect({
          label: "Voice",
          value: options.voice,
          options: TALK_VOICE_OPTIONS,
          onSelect: (voice) => onChange({ voice }),
        })}
        <label class="agent-chat__talk-field">
          <span>Model</span>
          <input
            .value=${options.model}
            @input=${(event: Event) =>
              onChange({ model: (event.currentTarget as HTMLInputElement).value })}
            placeholder="Auto"
            spellcheck="false"
          />
        </label>
        ${renderNativeTalkSelect({
          label: "Sensitivity",
          value: options.vadThreshold,
          options: TALK_SENSITIVITY_OPTIONS,
          onSelect: (vadThreshold) => onChange({ vadThreshold }),
        })}
      </div>
      ${props.onOpenRealtimeTalkSettings
        ? html`
            <button
              type="button"
              class="agent-chat__talk-settings-link"
              @click=${props.onOpenRealtimeTalkSettings}
              ?disabled=${props.canOpenRealtimeTalkSettings === false}
              title=${props.canOpenRealtimeTalkSettings === false
                ? "Advanced Talk settings require operator.admin access."
                : ""}
            >
              ${props.canOpenRealtimeTalkSettings === false
                ? "Advanced settings require admin"
                : "More in Settings"}
            </button>
          `
        : nothing}
    </div>
  `;
}

export function renderRealtimeTalkConversation(props: ChatRealtimeTalkConversationProps) {
  const entries = props.realtimeTalkConversation ?? [];
  if (entries.length === 0) {
    return nothing;
  }
  return html`
    <div class="agent-chat__voice-turns" role="log" aria-label=${t("chat.composer.talkTranscript")}>
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
              ${entry.isStreaming
                ? html`<span
                    class="agent-chat__voice-turn-stream"
                    aria-label=${t("chat.composer.stillListening")}
                  ></span>`
                : nothing}
            </div>
          `;
        },
      )}
    </div>
  `;
}
