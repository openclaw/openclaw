import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../../../i18n/index.ts";
import {
  REALTIME_TALK_FALLBACK_PROVIDERS,
  listSelectableRealtimeTalkProviders,
  resolveControlUiRealtimeTalkProviderTransports,
  type RealtimeTalkCatalogProvider,
} from "../realtime-talk-catalog.ts";
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
const TALK_PROVIDER_AUTO_OPTION: TalkSelectOption = { label: "Auto", value: "" };
const TALK_PROVIDER_FALLBACK_OPTIONS: TalkSelectOption[] = [
  TALK_PROVIDER_AUTO_OPTION,
  ...REALTIME_TALK_FALLBACK_PROVIDERS.map((provider) => ({
    label: provider.label,
    value: provider.id,
  })),
];
const TALK_TRANSPORT_OPTIONS: TalkSelectOption[] = [
  { label: "Auto", value: "" },
  { label: "WebRTC", value: "webrtc" },
  { label: "Gateway relay", value: "gateway-relay" },
  { label: "Provider WebSocket", value: "provider-websocket" },
];
const TALK_REASONING_OPTIONS: TalkSelectOption[] = [
  { label: "Default", value: "" },
  { label: "Minimal", value: "minimal" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
];

export type RealtimeTalkOptions = {
  provider: string;
  model: string;
  voice: string;
  transport: string;
  vadThreshold: string;
  silenceDurationMs: string;
  prefixPaddingMs: string;
  reasoningEffort: string;
};

export type ChatRealtimeTalkOptionsProps = {
  realtimeTalkOptionsOpen?: boolean;
  realtimeTalkCatalogProviders?: RealtimeTalkCatalogProvider[] | null;
  realtimeTalkOptions?: RealtimeTalkOptions;
  onRealtimeTalkOptionsChange?: (next: Partial<RealtimeTalkOptions>) => void;
};

export type ChatRealtimeTalkConversationProps = {
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
  const catalogProviders = props.realtimeTalkCatalogProviders;
  const selectableProviders = listSelectableRealtimeTalkProviders(catalogProviders ?? []);
  const providerOptions: TalkSelectOption[] = catalogProviders
    ? [
        TALK_PROVIDER_AUTO_OPTION,
        ...selectableProviders.map((provider) => ({ label: provider.label, value: provider.id })),
      ]
    : TALK_PROVIDER_FALLBACK_OPTIONS;
  const selectedCatalogProvider = options.provider
    ? selectableProviders.find((provider) => provider.id === options.provider)
    : null;
  const selectedProviderTransports = selectedCatalogProvider
    ? resolveControlUiRealtimeTalkProviderTransports(selectedCatalogProvider)
    : undefined;
  const transportOptions: TalkSelectOption[] = selectedProviderTransports
    ? [
        { label: "Auto", value: "" },
        ...TALK_TRANSPORT_OPTIONS.filter(
          (opt) => opt.value !== "" && selectedProviderTransports.includes(opt.value),
        ),
      ]
    : TALK_TRANSPORT_OPTIONS;
  const update = (key: keyof RealtimeTalkOptions) => (event: Event) => {
    const value = (event.currentTarget as HTMLInputElement | HTMLSelectElement).value;
    onChange({ [key]: value });
  };
  const isDefaultSensitivity = options.vadThreshold === "";
  const isPresetSensitivity = ["0.65", "0.5", "0.35"].includes(options.vadThreshold);
  const isCustomSensitivity = !isDefaultSensitivity && !isPresetSensitivity;
  const sensitivityValue = isDefaultSensitivity
    ? ""
    : isPresetSensitivity
      ? options.vadThreshold
      : "__custom";
  const sensitivityOptions = isCustomSensitivity
    ? [...TALK_SENSITIVITY_OPTIONS, { label: "Custom", value: "__custom" }]
    : TALK_SENSITIVITY_OPTIONS;
  const updateSensitivity = (value: string) => {
    if (value !== "__custom") {
      onChange({ vadThreshold: value });
    }
  };
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
            @input=${update("model")}
            placeholder="Auto"
            spellcheck="false"
          />
        </label>
        ${renderNativeTalkSelect({
          label: "Sensitivity",
          value: sensitivityValue,
          options: sensitivityOptions,
          onSelect: updateSensitivity,
        })}
      </div>
      <details class="agent-chat__talk-options-advanced">
        <summary>Advanced</summary>
        <div class="agent-chat__talk-options-grid">
          ${renderNativeTalkSelect({
            label: "Provider",
            value: options.provider,
            options: providerOptions,
            onSelect: (provider) => {
              const selectedProvider = selectableProviders.find((entry) => entry.id === provider);
              const transports = selectedProvider
                ? resolveControlUiRealtimeTalkProviderTransports(selectedProvider)
                : null;
              const transport = options.transport;
              onChange(
                transports && transport && !transports.includes(transport)
                  ? { provider, transport: "" }
                  : { provider },
              );
            },
          })}
          ${renderNativeTalkSelect({
            label: "Transport",
            value: options.transport,
            options: transportOptions,
            onSelect: (transport) => onChange({ transport }),
          })}
          ${renderNativeTalkSelect({
            label: "Reasoning",
            value: options.reasoningEffort,
            options: TALK_REASONING_OPTIONS,
            onSelect: (reasoningEffort) => onChange({ reasoningEffort }),
          })}
          <label class="agent-chat__talk-field">
            <span>Exact VAD</span>
            <input
              type="number"
              min="0"
              max="1"
              step="0.05"
              .value=${options.vadThreshold}
              @input=${update("vadThreshold")}
              placeholder="0.5"
            />
          </label>
          <label class="agent-chat__talk-field">
            <span>Pause before send</span>
            <input
              type="number"
              min="1"
              step="50"
              .value=${options.silenceDurationMs}
              @input=${update("silenceDurationMs")}
              placeholder="500"
            />
          </label>
          <label class="agent-chat__talk-field">
            <span>Lead-in</span>
            <input
              type="number"
              min="0"
              step="50"
              .value=${options.prefixPaddingMs}
              @input=${update("prefixPaddingMs")}
              placeholder="300"
            />
          </label>
        </div>
      </details>
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
