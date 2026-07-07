import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { RealtimeTalkConversationEntry } from "../realtime-talk-conversation.ts";
import type { RealtimeTalkInputDevice } from "../realtime-talk-input.ts";

type TalkSelectOption = { label: string; value: string };

const TALK_VOICE_OPTIONS: TalkSelectOption[] = [
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
export type RealtimeTalkOptions = {
  model: string;
  voice: string;
  vadThreshold: string;
};

export type ChatRealtimeTalkOptionsProps = {
  realtimeTalkOptions?: RealtimeTalkOptions;
  onRealtimeTalkOptionsChange?: (next: Partial<RealtimeTalkOptions>) => void;
  canOpenRealtimeTalkSettings?: boolean;
  onOpenRealtimeTalkSettings?: () => void;
  embedded?: boolean;
};

type ChatRealtimeTalkInputProps = {
  realtimeTalkInputOpen?: boolean;
  realtimeTalkInputDevices?: RealtimeTalkInputDevice[];
  realtimeTalkInputDeviceId?: string;
  realtimeTalkInputLoading?: boolean;
  realtimeTalkInputError?: string | null;
  onRealtimeTalkInputSelect?: (deviceId: string) => void;
};

type ChatRealtimeTalkConversationProps = {
  assistantName: string;
  userName?: string | null;
  realtimeTalkConversation?: RealtimeTalkConversationEntry[];
};

function renderNativeTalkSelect(params: {
  id: "sensitivity" | "voice";
  label: string;
  value: string;
  options: TalkSelectOption[];
  onSelect: (value: string) => void;
}) {
  return html`
    <label class="agent-chat__talk-field" data-talk-select=${params.id}>
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

function getTalkVoiceOptions(): TalkSelectOption[] {
  return [{ label: t("chat.composer.talkDefault"), value: "" }, ...TALK_VOICE_OPTIONS];
}

function getTalkSensitivityOptions(): TalkSelectOption[] {
  return [
    { label: t("chat.composer.talkDefault"), value: "" },
    { label: t("chat.composer.talkSensitivityLow"), value: "0.65" },
    { label: t("chat.composer.talkSensitivityMedium"), value: "0.5" },
    { label: t("chat.composer.talkSensitivityHigh"), value: "0.35" },
  ];
}

export function renderRealtimeTalkOptions(props: ChatRealtimeTalkOptionsProps) {
  const options = props.realtimeTalkOptions;
  const onChange = props.onRealtimeTalkOptionsChange;
  if (!options || !onChange) {
    return nothing;
  }
  return html`
    <div
      class="agent-chat__talk-options ${props.embedded ? "agent-chat__talk-options--settings" : ""}"
      aria-label=${t("chat.composer.voiceOptions")}
    >
      <div class="agent-chat__talk-options-primary">
        ${renderNativeTalkSelect({
          id: "voice",
          label: t("chat.composer.talkVoice"),
          value: options.voice,
          options: getTalkVoiceOptions(),
          onSelect: (voice) => onChange({ voice }),
        })}
        <label class="agent-chat__talk-field">
          <span>${t("chat.composer.talkModel")}</span>
          <input
            .value=${options.model}
            @input=${(event: Event) =>
              onChange({ model: (event.currentTarget as HTMLInputElement).value })}
            placeholder=${t("chat.composer.talkModelAuto")}
            spellcheck="false"
          />
        </label>
        ${renderNativeTalkSelect({
          id: "sensitivity",
          label: t("chat.composer.talkSensitivity"),
          value: options.vadThreshold,
          options: getTalkSensitivityOptions(),
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
                ? t("chat.composer.talkAdvancedSettingsRequiresAdminTitle")
                : ""}
            >
              ${props.canOpenRealtimeTalkSettings === false
                ? t("chat.composer.talkAdvancedSettingsRequiresAdmin")
                : t("chat.composer.talkMoreInSettings")}
            </button>
          `
        : nothing}
    </div>
  `;
}

export function renderRealtimeTalkInputPicker(props: ChatRealtimeTalkInputProps, menuId: string) {
  if (!props.realtimeTalkInputOpen || !props.onRealtimeTalkInputSelect) {
    return nothing;
  }
  const selectedDeviceId = props.realtimeTalkInputDeviceId ?? "";
  const devices = props.realtimeTalkInputDevices ?? [];
  const renderOption = (deviceId: string, label: string) => {
    const selected = selectedDeviceId === deviceId;
    return html`
      <button
        type="button"
        class="agent-chat__talk-input-option ${selected
          ? "agent-chat__talk-input-option--selected"
          : ""}"
        aria-pressed=${selected ? "true" : "false"}
        @click=${() => props.onRealtimeTalkInputSelect?.(deviceId)}
      >
        <span>${label}</span>
        ${selected
          ? html`<span class="agent-chat__talk-input-check" aria-hidden="true"
              >${icons.check}</span
            >`
          : nothing}
      </button>
    `;
  };
  return html`
    <div
      class="agent-chat__talk-input-menu"
      id=${menuId}
      role="group"
      aria-label=${t("chat.composer.microphoneInput")}
    >
      <div class="agent-chat__talk-input-heading">
        <span>${t("chat.composer.microphoneInput")}</span>
        ${props.realtimeTalkInputLoading
          ? html`<span class="agent-chat__talk-input-spinner" aria-hidden="true"
              >${icons.loader}</span
            >`
          : nothing}
      </div>
      <div class="agent-chat__talk-input-options">
        ${renderOption("", t("chat.composer.systemDefaultMicrophone"))}
        ${repeat(
          devices,
          (device) => device.deviceId,
          (device) => renderOption(device.deviceId, device.label),
        )}
      </div>
      ${props.realtimeTalkInputLoading && devices.length === 0
        ? html`<div class="agent-chat__talk-input-message" role="status" aria-live="polite">
            ${t("chat.composer.loadingMicrophones")}
          </div>`
        : nothing}
      ${!props.realtimeTalkInputLoading && devices.length === 0 && !props.realtimeTalkInputError
        ? html`<div class="agent-chat__talk-input-message" role="status">
            ${t("chat.composer.noMicrophones")}
          </div>`
        : nothing}
      ${props.realtimeTalkInputError
        ? html`<div
            class="agent-chat__talk-input-message agent-chat__talk-input-message--error"
            role="alert"
          >
            ${props.realtimeTalkInputError}
          </div>`
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
