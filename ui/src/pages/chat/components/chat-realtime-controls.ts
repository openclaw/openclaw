import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { RealtimeTalkConversationEntry } from "../realtime-talk-conversation.ts";
import type { RealtimeTalkInputDevice } from "../realtime-talk-input.ts";

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
