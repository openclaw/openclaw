// Chat-owned model, reasoning, and speed picker.
import { html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { ModelCatalogEntry, SessionsListResult } from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import {
  resolveChatFastModeSelectState,
  resolveChatModelSelectState,
  type ChatFastModeSelectState,
  type ChatFastModeSelectValue,
  type ChatModelSelectOption,
} from "../../../lib/chat/model-select-state.ts";
import {
  formatThinkingOverrideLabel,
  resolveChatThinkingSelectState,
} from "../../../lib/chat/thinking.ts";

export type ChatModelControlsProps = {
  activeRunId: string | null;
  agentDefaultModel?: string;
  connected: boolean;
  gatewayAvailable: boolean;
  loading: boolean;
  modelCatalog: ModelCatalogEntry[];
  modelOverrides?: Readonly<Record<string, string | null | undefined>>;
  modelSwitching: boolean;
  modelsLoading?: boolean;
  sending: boolean;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
  stream: string | null;
  onFastModeSelect?: (value: ChatFastModeSelectValue) => unknown;
  onModelSelect?: (value: string) => unknown;
  onThinkingSelect?: (value: string) => unknown;
};

export function renderChatModelControls(props: ChatModelControlsProps) {
  const {
    currentOverride,
    defaultLabel,
    options: selectOptions,
  } = resolveChatModelSelectState({
    agentDefaultModel: props.agentDefaultModel,
    chatModelCatalog: props.modelCatalog,
    modelOverrides: props.modelOverrides ?? {},
    sessionKey: props.sessionKey,
    sessionsResult: props.sessionsResult,
  });
  const thinking = resolveChatThinkingSelectState({
    catalog: props.modelCatalog,
    sessionKey: props.sessionKey,
    sessionsResult: props.sessionsResult,
  });
  const fastMode = resolveChatFastModeSelectState({
    activeRunId: props.activeRunId,
    catalog: props.modelCatalog,
    connected: props.connected,
    currentModelOverride: currentOverride,
    gatewayAvailable: props.gatewayAvailable,
    loading: props.loading,
    sending: props.sending,
    sessionKey: props.sessionKey,
    sessionsResult: props.sessionsResult,
    stream: props.stream,
  });
  const busy =
    props.loading || props.sending || Boolean(props.activeRunId) || props.stream !== null;
  const disabled =
    !props.connected ||
    busy ||
    props.modelSwitching ||
    (props.modelsLoading && selectOptions.length === 0) ||
    !props.gatewayAvailable;
  const thinkingDisabled =
    !props.connected ||
    busy ||
    !props.gatewayAvailable ||
    (thinking.options.length === 0 && thinking.currentOverride === "");
  const selectedLabel =
    currentOverride === ""
      ? defaultLabel
      : (selectOptions.find((entry) => entry.value === currentOverride)?.label ?? currentOverride);
  const selectedThinkingLabel =
    thinking.currentOverride === ""
      ? thinking.defaultLabel
      : (thinking.options.find((entry) => entry.value === thinking.currentOverride)?.label ??
        thinking.currentOverride);

  return renderChatModelReasoningSelect({
    disabled,
    fastMode,
    modelOptions: [{ value: "", label: defaultLabel }, ...selectOptions],
    selectedModelLabel: selectedLabel,
    selectedModelValue: currentOverride,
    selectedThinkingLabel,
    selectedThinkingValue: thinking.currentOverride,
    thinkingDefaultValue: thinking.defaultValue,
    thinkingDisabled,
    thinkingOptions: [{ value: "", label: thinking.defaultLabel }, ...thinking.options],
    onFastModeSelect: async (next) => props.onFastModeSelect?.(next),
    onModelSelect: async (next) => props.onModelSelect?.(next),
    onThinkingSelect: async (next) => props.onThinkingSelect?.(next),
  });
}

function formatCombinedPickerModelLabel(label: string): string {
  const match = /^Default \((.+)\)$/u.exec(label);
  return match?.[1] ?? label;
}

function formatCombinedPickerModelOptionLabel(
  option: ChatModelSelectOption,
  selected: boolean,
): string {
  return option.value === "" && selected
    ? formatCombinedPickerModelLabel(option.label)
    : option.label;
}

function formatCombinedPickerThinkingLabel(label: string): string {
  return label.replace(/^Inherited:\s*/u, "");
}

function renderChatModelReasoningSelect(params: {
  fastMode: ChatFastModeSelectState;
  disabled: boolean;
  modelOptions: ChatModelSelectOption[];
  selectedModelLabel: string;
  selectedModelValue: string;
  selectedThinkingLabel: string;
  selectedThinkingValue: string;
  thinkingDefaultValue: string;
  thinkingDisabled: boolean;
  thinkingOptions: ChatModelSelectOption[];
  onFastModeSelect: (value: ChatFastModeSelectValue) => Promise<unknown>;
  onModelSelect: (value: string) => Promise<unknown>;
  onThinkingSelect: (value: string) => Promise<unknown>;
}) {
  const {
    disabled,
    fastMode,
    modelOptions,
    selectedModelLabel,
    selectedModelValue,
    selectedThinkingLabel,
    selectedThinkingValue,
    thinkingDefaultValue,
    thinkingDisabled,
    thinkingOptions,
    onFastModeSelect,
    onModelSelect,
    onThinkingSelect,
  } = params;
  const triggerModel = formatCombinedPickerModelLabel(selectedModelLabel);
  const triggerThinking = formatCombinedPickerThinkingLabel(selectedThinkingLabel);
  const triggerTitle = `${triggerModel} · ${triggerThinking}`;
  const sliderStops = thinkingOptions.filter((option) => option.value !== "");
  const defaultStopIndex = sliderStops.findIndex((option) => option.value === thinkingDefaultValue);
  const hasThinkingOverride = selectedThinkingValue !== "";
  const overrideStopIndex = sliderStops.findIndex(
    (option) => option.value === selectedThinkingValue,
  );
  const sliderIndex = Math.max(hasThinkingOverride ? overrideStopIndex : defaultStopIndex, 0);
  const sliderUnanchored = !hasThinkingOverride && defaultStopIndex < 0;
  const sliderFillPercent = (index: number) =>
    sliderStops.length > 1 ? (index / (sliderStops.length - 1)) * 100 : 0;
  const reasoningValueLabel = hasThinkingOverride
    ? triggerThinking
    : `Default (${triggerThinking})`;
  const defaultLevelLabel = formatThinkingOverrideLabel(thinkingDefaultValue);
  const onSliderDrag = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    input.style.setProperty("--reasoning-fill", `${sliderFillPercent(Number(input.value))}%`);
  };
  const onSliderCommit = async (event: Event) => {
    if (thinkingDisabled) {
      return;
    }
    const input = event.currentTarget as HTMLInputElement;
    const stop = sliderStops[Number(input.value)];
    if (!stop || stop.value === selectedThinkingValue) {
      return;
    }
    await onThinkingSelect(stop.value);
  };
  const showReasoning = sliderStops.length > 0;
  const onlyStop = sliderStops.length === 1 ? sliderStops[0] : undefined;
  const showReasoningPanel = showReasoning || fastMode.supported;
  return html`
    <details class="chat-controls__session chat-controls__inline-select chat-controls__model">
      <summary
        class="chat-controls__inline-select-trigger ${disabled
          ? "chat-controls__inline-select-trigger--disabled"
          : ""}"
        data-chat-model-select="true"
        data-chat-thinking-select="true"
        data-chat-select-value=${selectedModelValue}
        data-chat-thinking-value=${selectedThinkingValue}
        data-chat-thinking-disabled=${thinkingDisabled ? "true" : "false"}
        aria-label=${`${t("chat.selectors.model")}, ${t("chat.selectors.thinkingLevel")}: ${triggerTitle}`}
        aria-disabled=${disabled ? "true" : "false"}
        @click=${(event: MouseEvent) => {
          if (disabled) {
            event.preventDefault();
          }
        }}
      >
        <span class="chat-controls__inline-select-label">${triggerModel}</span>
        ${showReasoning || hasThinkingOverride
          ? html`<span
              class="chat-controls__effort-chip ${hasThinkingOverride
                ? "chat-controls__effort-chip--override"
                : ""}"
              aria-hidden="true"
              >${triggerThinking}</span
            >`
          : ""}
        <span class="chat-controls__inline-select-icon" aria-hidden="true">
          ${icons.chevronDown}
        </span>
      </summary>
      <div
        class="chat-controls__inline-select-menu chat-controls__inline-select-menu--combined"
        aria-label=${t("chat.selectors.model")}
      >
        <div class="chat-controls__inline-select-section-label">Model</div>
        <div class="chat-controls__combined-model-list">
          ${repeat(
            modelOptions,
            (entry) => entry.value,
            (entry) => {
              const selected = entry.value === selectedModelValue;
              return html`
                <div class="chat-controls__combined-model">
                  <button
                    class="chat-controls__inline-select-option chat-controls__combined-model-option ${selected
                      ? "chat-controls__inline-select-option--selected"
                      : ""}"
                    data-chat-model-option=${entry.value}
                    role="option"
                    aria-selected=${selected ? "true" : "false"}
                    type="button"
                    ?disabled=${disabled}
                    @click=${async (event: MouseEvent) => {
                      if (disabled || selected) {
                        event.preventDefault();
                        return;
                      }
                      (event.currentTarget as HTMLElement)
                        .closest("details")
                        ?.removeAttribute("open");
                      await onModelSelect(entry.value);
                    }}
                  >
                    <span>${formatCombinedPickerModelOptionLabel(entry, selected)}</span>
                    ${selected
                      ? html`<span
                          class="chat-controls__inline-select-check chat-controls__combined-model-arrow"
                          aria-hidden="true"
                        >
                          ${icons.chevronDown}
                        </span>`
                      : ""}
                  </button>
                </div>
              `;
            },
          )}
        </div>
        ${showReasoningPanel
          ? html`
              <div class="chat-controls__reasoning-panel">
                ${showReasoning
                  ? html`
                      <div class="chat-controls__reasoning-head">
                        <span class="chat-controls__inline-select-section-label">Reasoning</span>
                        <span class="chat-controls__reasoning-value">${reasoningValueLabel}</span>
                      </div>
                      ${sliderStops.length > 1
                        ? html`
                            <div class="chat-controls__reasoning-slider">
                              <div class="chat-controls__reasoning-dots" aria-hidden="true">
                                ${sliderStops.map(
                                  (stop, index) =>
                                    html`<span
                                      class="chat-controls__reasoning-dot ${index ===
                                      defaultStopIndex
                                        ? "chat-controls__reasoning-dot--default"
                                        : ""}"
                                      data-stop=${stop.value}
                                    ></span>`,
                                )}
                              </div>
                              <input
                                class="chat-controls__reasoning-range ${hasThinkingOverride
                                  ? ""
                                  : "chat-controls__reasoning-range--inherit"} ${sliderUnanchored
                                  ? "chat-controls__reasoning-range--unanchored"
                                  : ""}"
                                type="range"
                                min="0"
                                max=${sliderStops.length - 1}
                                step="1"
                                .value=${String(sliderIndex)}
                                style=${`--reasoning-fill: ${sliderFillPercent(sliderIndex)}%`}
                                data-chat-thinking-slider="true"
                                data-chat-thinking-values=${sliderStops
                                  .map((stop) => stop.value)
                                  .join(",")}
                                aria-label=${t("chat.selectors.thinkingLevel")}
                                aria-valuetext=${reasoningValueLabel}
                                ?disabled=${thinkingDisabled}
                                @input=${onSliderDrag}
                                @change=${onSliderCommit}
                              />
                            </div>
                            <div class="chat-controls__reasoning-scale" aria-hidden="true">
                              <span>Faster</span>
                              <span>Smarter</span>
                            </div>
                          `
                        : onlyStop
                          ? html`
                              <button
                                class="chat-controls__reasoning-option ${hasThinkingOverride
                                  ? "chat-controls__reasoning-option--selected"
                                  : ""}"
                                data-chat-thinking-option=${onlyStop.value}
                                type="button"
                                aria-pressed=${hasThinkingOverride ? "true" : "false"}
                                ?disabled=${thinkingDisabled}
                                @click=${async (event: MouseEvent) => {
                                  event.stopPropagation();
                                  if (thinkingDisabled || hasThinkingOverride) {
                                    event.preventDefault();
                                    return;
                                  }
                                  await onThinkingSelect(onlyStop.value);
                                }}
                              >
                                <span>${onlyStop.label}</span>
                                ${hasThinkingOverride
                                  ? html`<span
                                      class="chat-controls__inline-select-check"
                                      aria-hidden="true"
                                    >
                                      ${icons.check}
                                    </span>`
                                  : ""}
                              </button>
                            `
                          : ""}
                      ${hasThinkingOverride
                        ? html`
                            <button
                              class="chat-controls__reasoning-reset"
                              data-chat-thinking-option=""
                              type="button"
                              ?disabled=${thinkingDisabled}
                              @click=${async (event: MouseEvent) => {
                                event.stopPropagation();
                                if (thinkingDisabled) {
                                  event.preventDefault();
                                  return;
                                }
                                await onThinkingSelect("");
                              }}
                            >
                              Use default (${defaultLevelLabel})
                            </button>
                          `
                        : ""}
                    `
                  : ""}
                ${fastMode.supported
                  ? html`
                      <div class="chat-controls__inline-select-section-label">Speed</div>
                      <div class="chat-controls__reasoning-options" role="listbox">
                        ${repeat(
                          fastMode.options,
                          (speed) => speed.value,
                          (speed) => {
                            const speedValue = speed.value as ChatFastModeSelectValue;
                            const speedSelected = speedValue === fastMode.currentOverride;
                            return html`
                              <button
                                class="chat-controls__reasoning-option ${speedSelected
                                  ? "chat-controls__reasoning-option--selected"
                                  : ""}"
                                data-chat-speed-option=${speed.value}
                                role="option"
                                aria-selected=${speedSelected ? "true" : "false"}
                                type="button"
                                ?disabled=${fastMode.disabled}
                                @click=${async (event: MouseEvent) => {
                                  event.stopPropagation();
                                  if (fastMode.disabled) {
                                    event.preventDefault();
                                    return;
                                  }
                                  (event.currentTarget as HTMLElement)
                                    .closest("details")
                                    ?.removeAttribute("open");
                                  await onFastModeSelect(speedValue);
                                }}
                              >
                                <span>${speed.label}</span>
                                ${speedSelected
                                  ? html`<span
                                      class="chat-controls__inline-select-check"
                                      aria-hidden="true"
                                    >
                                      ${icons.check}
                                    </span>`
                                  : ""}
                              </button>
                            `;
                          },
                        )}
                      </div>
                    `
                  : ""}
              </div>
            `
          : ""}
      </div>
    </details>
  `;
}
