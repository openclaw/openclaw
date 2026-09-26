import { html, nothing, svg } from "lit";
import { strokeIcon } from "../../../components/icons-tools.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import type {
  ChatFastModeSelectState,
  ChatFastModeSelectValue,
} from "../../../lib/chat/model-select-state.ts";
import {
  normalizeThinkingOptionValue,
  type ChatThinkingSelectState,
} from "../../../lib/chat/thinking.ts";
import { handleChatComposerDetailsToggle, syncChatPickerOverlay } from "./chat-picker-overlay.ts";

registerModelControlsEnglish();

const autoSteerIcon = strokeIcon(svg`<path d="m18 14 4 4-4 4" />
    <path d="m18 2 4 4-4 4" />
    <path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22" />
    <path d="M2 6h1.972a4 4 0 0 1 3.6 2.2" />
    <path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45" />`);

export type ChatAutoSteerControl = {
  active: boolean;
  disabled?: boolean;
  onSelect: (enabled: boolean) => void;
};

type ChatEffortPickerParams = {
  autoSteer?: ChatAutoSteerControl;
  disabled: boolean;
  disabledReason?: string;
  fastMode: ChatFastModeSelectState;
  sessionKey: string;
  thinkingDisabled: boolean;
  thinking: ChatThinkingSelectState;
  onFastModeSelect: (value: ChatFastModeSelectValue, sessionKey: string) => Promise<unknown>;
  onRequestUpdate?: () => void;
  onThinkingSelect: (value: string, sessionKey: string) => Promise<unknown>;
  reserved?: boolean;
};

function formatEffortLabel(label: string): string {
  return label.replace(/^Inherited:\s*/u, "");
}

export function renderChatEffortPicker(params: ChatEffortPickerParams) {
  const sliderStops = params.thinking.options;
  const showReasoning = sliderStops.length > 0;
  if (!params.reserved && !showReasoning && !params.fastMode.supported && !params.autoSteer) {
    return nothing;
  }
  const selection = params.thinking.selection;
  const effortIsOff = normalizeThinkingOptionValue(selection.value) === "off";
  const effortFraction =
    effortIsOff || selection.kind === "unanchored"
      ? 0
      : sliderStops.length > 1
        ? selection.index / (sliderStops.length - 1)
        : 1;
  const effortAngle = -120 + effortFraction * 240;
  const hasThinkingOverride = selection.source === "override";
  const selectedThinkingValue = hasThinkingOverride ? selection.value : "";
  const sliderIndex = selection.kind === "anchored" ? selection.index : 0;
  const sliderUnanchored = selection.kind === "unanchored";
  // Binary providers can use a ranked wire value with the display label "On".
  const maximumIndex = sliderStops.findLastIndex(
    (stop) =>
      stop.label !== "On" &&
      ["minimal", "low", "medium", "high", "xhigh", "max"].includes(stop.value),
  );
  const sliderBoost = (index: number) =>
    sliderStops[index]?.value === "ultra" ? "ultra" : index === maximumIndex ? "max" : "";
  const committedBoost = sliderUnanchored ? "" : sliderBoost(sliderIndex);
  const sliderFillPercent = (index: number) =>
    sliderStops.length > 1 ? (index / (sliderStops.length - 1)) * 100 : 0;
  const defaultLevelLabel = formatEffortLabel(params.thinking.inherited.displayLabel);
  const reasoningValueText = formatEffortLabel(selection.displayLabel);
  const reasoningValueLabel = hasThinkingOverride
    ? reasoningValueText
    : t("chat.modelControls.defaultWithLevel", { level: defaultLevelLabel });
  const triggerLabel = showReasoning
    ? reasoningValueText
    : t(params.fastMode.supported ? "chat.modelControls.fastMode" : "chat.modelControls.autoSteer");
  const triggerTitle = showReasoning
    ? params.fastMode.active
      ? `${triggerLabel} · ${t("chat.modelControls.fastMode")}`
      : triggerLabel
    : params.fastMode.supported
      ? `${triggerLabel}: ${params.fastMode.label}`
      : triggerLabel;
  const commitThinking = (value: string) => {
    void params
      .onThinkingSelect(value, params.sessionKey)
      .finally(() => params.onRequestUpdate?.());
    params.onRequestUpdate?.();
  };
  const commitFastMode = (value: ChatFastModeSelectValue) => {
    void params
      .onFastModeSelect(value, params.sessionKey)
      .finally(() => params.onRequestUpdate?.());
    params.onRequestUpdate?.();
  };
  const resetSliderPreview = (input: HTMLInputElement, restoreValue = false) => {
    if (restoreValue) {
      input.value = String(sliderIndex);
    }
    input.style.setProperty("--reasoning-fill", `${sliderFillPercent(sliderIndex)}%`);
    input.dataset.effortBoost = committedBoost;
    input.setAttribute("aria-valuetext", reasoningValueLabel);
    const panel = input.closest(".chat-controls__reasoning-panel");
    panel?.querySelectorAll<HTMLElement>("[data-chat-thinking-preview-index]").forEach((label) => {
      label.hidden = true;
    });
    const committedLabel = panel?.querySelector<HTMLElement>(
      "[data-chat-thinking-preview-committed]",
    );
    if (committedLabel) {
      committedLabel.hidden = false;
    }
  };
  const onSliderDrag = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const stop = sliderStops[Number(input.value)];
    if (!stop) {
      return;
    }
    input.style.setProperty("--reasoning-fill", `${sliderFillPercent(Number(input.value))}%`);
    input.dataset.effortBoost = sliderBoost(Number(input.value));
    input.setAttribute("aria-valuetext", formatEffortLabel(stop.label));
    const panel = input.closest(".chat-controls__reasoning-panel");
    panel?.querySelectorAll<HTMLElement>("[data-chat-thinking-preview-index]").forEach((label) => {
      label.hidden = label.dataset.chatThinkingPreviewIndex !== input.value;
    });
    const committedLabel = panel?.querySelector<HTMLElement>(
      "[data-chat-thinking-preview-committed]",
    );
    if (committedLabel) {
      committedLabel.hidden = true;
    }
  };
  const onSliderCommit = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const stop = sliderStops[Number(input.value)];
    resetSliderPreview(input);
    if (params.thinkingDisabled || !stop || stop.value === selectedThinkingValue) {
      return;
    }
    commitThinking(stop.value);
  };
  const onUnanchoredSliderClick = (event: MouseEvent) => {
    const input = event.currentTarget as HTMLInputElement;
    if (sliderUnanchored && Number(input.value) === sliderIndex) {
      onSliderCommit(event);
    }
  };
  const onUnanchoredSliderKeyDown = (event: KeyboardEvent) => {
    if (sliderUnanchored && ["Home", "ArrowLeft", "ArrowDown", "PageDown"].includes(event.key)) {
      onSliderCommit(event);
    }
  };
  const onlyStop = sliderStops.length === 1 ? sliderStops[0] : undefined;
  const onlyStopSelected = selection.kind === "anchored" && selection.index === 0;
  return html`
    <details
      class="chat-controls__inline-select chat-controls__effort-picker ${
        params.reserved ? "chat-controls__effort-picker--reserved" : ""
      }"
      aria-hidden=${String(params.reserved === true)}
      ?inert=${params.reserved === true}
      @toggle=${(event: Event) => {
        const details = event.currentTarget as HTMLDetailsElement;
        handleChatComposerDetailsToggle(event);
        syncChatPickerOverlay(details);
      }}
    >
      <summary
        class="chat-controls__inline-select-trigger chat-controls__effort-trigger ${
          params.fastMode.active ? "chat-controls__effort-trigger--fast" : ""
        } ${params.disabled ? "chat-controls__inline-select-trigger--disabled" : ""}"
        data-chat-thinking-select="true"
        data-chat-thinking-value=${selectedThinkingValue}
        data-chat-thinking-disabled=${params.thinkingDisabled ? "true" : "false"}
        data-chat-fast-mode=${params.fastMode.active ? "true" : "false"}
        aria-label=${
          showReasoning ? `${t("chat.selectors.thinkingLevel")}: ${triggerTitle}` : triggerTitle
        }
        aria-disabled=${params.disabled ? "true" : "false"}
        title=${params.disabledReason ?? triggerTitle}
        @click=${(event: MouseEvent) => {
          if (params.disabled) {
            event.preventDefault();
          }
        }}
      >
        ${
          params.fastMode.active
            ? html`<span class="chat-controls__effort-zap" aria-hidden="true">${icons.zap}</span>`
            : nothing
        }
        ${
          showReasoning
            ? html`
                <span
                  class="chat-controls__effort-gauge ${
                    effortIsOff ? "chat-controls__effort-gauge--off" : ""
                  }"
                  aria-hidden="true"
                >
                  ${strokeIcon(svg`
                  <path class="chat-controls__effort-gauge-dial" d="M3.34 17a10 10 0 1 1 17.32 0" />
                  <path
                    class="chat-controls__effort-gauge-needle"
                    d="M12 12V6"
                    style=${`transform: rotate(${effortAngle}deg)`}
                  />
                  <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
                `)}
                  ${
                    params.fastMode.active
                      ? html`<span class="chat-controls__effort-fast-badge">${icons.zap}</span>`
                      : nothing
                  }
                </span>
              `
            : html`<span class="chat-controls__effort-speed" aria-hidden="true"
                >${params.autoSteer && !params.fastMode.supported ? autoSteerIcon : icons.zap}</span
              >`
        }
        <span class="chat-controls__inline-select-label">${triggerLabel}</span>
        <span class="chat-controls__inline-select-chevron" aria-hidden="true"
          >${icons.chevronUp}</span
        >
      </summary>
      <wa-popup data-anchored-overlay>
        <div
          class="chat-controls__inline-select-menu chat-controls__effort-menu"
          aria-label=${t(
            showReasoning
              ? "chat.modelControls.effort"
              : params.fastMode.supported
                ? "chat.modelControls.fastMode"
                : "chat.modelControls.autoSteer",
          )}
        >
          ${
            showReasoning
              ? html`
                  <div class="chat-controls__reasoning-panel">
                    <div class="chat-controls__reasoning-head">
                      <span class="chat-controls__effort-heading">
                        ${t("chat.modelControls.effort")}
                      </span>
                      <span class="chat-controls__effort-value" aria-hidden="true">
                        <span data-chat-thinking-preview-committed>${reasoningValueText}</span>
                        ${sliderStops.map(
                          (stop, index) => html`<span
                            data-chat-thinking-preview-index=${index}
                            hidden
                            >${formatEffortLabel(stop.label)}</span
                          >`,
                        )}
                      </span>
                    </div>
                    ${
                      sliderStops.length > 1
                        ? html`
                            <div class="chat-controls__reasoning-slider">
                              <div class="chat-controls__reasoning-dots" aria-hidden="true">
                                ${sliderStops.map(
                                  (stop) => html`<span
                                    class="chat-controls__reasoning-dot"
                                    data-stop=${stop.value}
                                  ></span>`,
                                )}
                              </div>
                              <input
                                class="chat-controls__reasoning-range ${
                                  hasThinkingOverride
                                    ? ""
                                    : "chat-controls__reasoning-range--inherit"
                                } ${
                                  sliderUnanchored
                                    ? "chat-controls__reasoning-range--unanchored"
                                    : ""
                                }"
                                type="range"
                                min="0"
                                max=${sliderStops.length - 1}
                                step="1"
                                .value=${String(sliderIndex)}
                                style=${`--reasoning-fill: ${sliderFillPercent(sliderIndex)}%`}
                                data-chat-thinking-slider="true"
                                data-effort-boost=${committedBoost}
                                data-chat-thinking-values=${sliderStops
                                  .map((stop) => stop.value)
                                  .join(",")}
                                aria-label=${t("chat.selectors.thinkingLevel")}
                                aria-valuetext=${reasoningValueLabel}
                                ?disabled=${params.thinkingDisabled}
                                @input=${onSliderDrag}
                                @change=${onSliderCommit}
                                @click=${onUnanchoredSliderClick}
                                @keydown=${onUnanchoredSliderKeyDown}
                                @pointercancel=${(event: PointerEvent) =>
                                  resetSliderPreview(event.currentTarget as HTMLInputElement, true)}
                                @blur=${(event: FocusEvent) =>
                                  resetSliderPreview(event.currentTarget as HTMLInputElement, true)}
                              />
                            </div>
                            <div class="chat-controls__effort-scale" aria-hidden="true">
                              <span>${t("chat.modelControls.faster")}</span>
                              <span>${t("chat.modelControls.smarter")}</span>
                            </div>
                          `
                        : onlyStop
                          ? html`
                              <button
                                class="chat-controls__reasoning-option ${
                                  onlyStopSelected
                                    ? "chat-controls__reasoning-option--selected"
                                    : ""
                                }"
                                data-chat-thinking-option=${onlyStop.value}
                                type="button"
                                aria-pressed=${onlyStopSelected ? "true" : "false"}
                                ?disabled=${params.thinkingDisabled}
                                @click=${(event: MouseEvent) => {
                                  event.stopPropagation();
                                  if (params.thinkingDisabled || onlyStopSelected) {
                                    event.preventDefault();
                                    return;
                                  }
                                  commitThinking(onlyStop.value);
                                }}
                              >
                                <span>${onlyStop.label}</span>
                                ${
                                  onlyStopSelected
                                    ? html`<span
                                        class="chat-controls__inline-select-check"
                                        aria-hidden="true"
                                        >${icons.check}</span
                                      >`
                                    : nothing
                                }
                              </button>
                            `
                          : nothing
                    }
                  </div>
                `
              : nothing
          }
          <div class="chat-controls__fast-mode-row">
            <span class="chat-controls__fast-mode-icon" aria-hidden="true">${icons.zap}</span>
            <span class="chat-controls__fast-mode-copy">
              <span class="chat-controls__fast-mode-title">
                ${t("chat.modelControls.fastMode")}
              </span>
              <span class="chat-controls__fast-mode-description">
                ${t("chat.modelControls.fastHelp")}
              </span>
            </span>
            <button
              class="chat-controls__speed-toggle ${
                params.fastMode.active ? "chat-controls__speed-toggle--active" : ""
              }"
              data-chat-speed-toggle=${params.fastMode.nextValue}
              type="button"
              role="switch"
              aria-checked=${params.fastMode.active ? "true" : "false"}
              aria-label=${t("chat.modelControls.fastResponsesAria", {
                state: params.fastMode.label,
              })}
              ?disabled=${params.fastMode.disabled}
              @click=${(event: MouseEvent) => {
                event.stopPropagation();
                if (params.fastMode.disabled) {
                  event.preventDefault();
                  return;
                }
                commitFastMode(params.fastMode.nextValue);
              }}
            >
              <span class="chat-controls__speed-toggle-thumb"></span>
            </button>
          </div>
          ${
            params.autoSteer
              ? html`
                  <div class="chat-controls__fast-mode-row" data-chat-auto-steer-row>
                    <span class="chat-controls__fast-mode-icon" aria-hidden="true"
                      >${autoSteerIcon}</span
                    >
                    <span class="chat-controls__fast-mode-copy">
                      <span class="chat-controls__fast-mode-title"
                        >${t("chat.modelControls.autoSteer")}</span
                      >
                      <span
                        class="chat-controls__fast-mode-description chat-controls__auto-description"
                        >${t("chat.modelControls.autoSteerHelp")}</span
                      >
                    </span>
                    <button
                      class="chat-controls__speed-toggle ${params.autoSteer.active ? "chat-controls__speed-toggle--active" : ""}"
                      data-chat-auto-steer-toggle
                      type="button"
                      role="switch"
                      aria-checked=${String(params.autoSteer.active)}
                      aria-label=${t("chat.modelControls.autoSteerAria")}
                      ?disabled=${params.autoSteer.disabled === true}
                      @click=${(event: MouseEvent) => {
                        event.stopPropagation();
                        if (!params.autoSteer?.disabled) {
                          params.autoSteer?.onSelect(!params.autoSteer.active);
                        }
                      }}
                    >
                      <span class="chat-controls__speed-toggle-thumb"></span>
                    </button>
                  </div>
                `
              : nothing
          }
        </div>
      </wa-popup>
    </details>
  `;
}
