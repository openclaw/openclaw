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
import type { ChatThinkingSelectState } from "../../../lib/chat/thinking.ts";
import { handleChatComposerDetailsToggle, syncChatPickerOverlay } from "./chat-picker-overlay.ts";

registerModelControlsEnglish();

type ChatEffortPickerParams = {
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
  if (!params.reserved && !showReasoning && !params.fastMode.supported) {
    return nothing;
  }
  const selection = params.thinking.selection;
  const effortIsOff = selection.value === "off";
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
  const ultrafast = params.fastMode.currentOverride === "ultrafast";
  const speedLabel = ultrafast
    ? t("chat.modelControls.ultrafast")
    : params.fastMode.currentOverride === "auto"
      ? params.fastMode.label
      : t("chat.modelControls.fast");
  const triggerLabel = showReasoning ? reasoningValueText : t("chat.modelControls.speed");
  const triggerTitle = [
    showReasoning
      ? params.fastMode.active
        ? `${triggerLabel} · ${speedLabel}`
        : triggerLabel
      : `${triggerLabel}: ${params.fastMode.label}`,
    params.fastMode.hint,
  ]
    .filter(Boolean)
    .join(" · ");
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
  const speedOptions: { value: ChatFastModeSelectValue; label: string; disabled?: boolean }[] = [
    {
      value: params.fastMode.nextValue === "" ? "" : "off",
      label: t("chat.modelControls.standard"),
    },
    ...(params.fastMode.nextValue === ""
      ? []
      : [{ value: "on" as const, label: t("chat.modelControls.fast") }]),
    ...(params.fastMode.ultrafastSupported !== undefined || ultrafast
      ? [
          {
            value: "ultrafast" as const,
            label: t("chat.modelControls.ultrafast"),
            disabled: !params.fastMode.ultrafastSupported,
          },
        ]
      : []),
  ];
  const selectedSpeed =
    params.fastMode.currentOverride === "auto"
      ? "auto"
      : ultrafast
        ? "ultrafast"
        : params.fastMode.active
          ? "on"
          : "off";
  const selectedSpeedIndex = speedOptions.findIndex(
    (option) => option.value === selectedSpeed && !option.disabled,
  );
  const tabbableSpeedIndex =
    selectedSpeedIndex >= 0
      ? selectedSpeedIndex
      : speedOptions.findIndex((option) => !option.disabled);
  const onSpeedKeyDown = (event: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      return;
    }
    const group = event.currentTarget;
    if (!(group instanceof HTMLElement)) {
      return;
    }
    const options = [...group.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    if (options.length === 0) {
      return;
    }
    const current = options.findIndex((option) => option === document.activeElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : (current + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) + options.length) %
            options.length;
    event.preventDefault();
    options[next]?.focus();
    options[next]?.click();
  };
  const syncSliderPreview = (input: HTMLInputElement, previewIndex?: number) => {
    const preview = previewIndex === undefined ? undefined : sliderStops[previewIndex];
    const index = previewIndex ?? sliderIndex;
    input.style.setProperty("--reasoning-fill", `${sliderFillPercent(index)}%`);
    input.dataset.effortBoost = preview ? sliderBoost(index) : committedBoost;
    input.setAttribute(
      "aria-valuetext",
      preview ? formatEffortLabel(preview.label) : reasoningValueLabel,
    );
    const panel = input.closest(".chat-controls__reasoning-panel");
    panel?.querySelectorAll<HTMLElement>("[data-chat-thinking-preview-index]").forEach((label) => {
      label.hidden = !preview || label.dataset.chatThinkingPreviewIndex !== input.value;
    });
    const committedLabel = panel?.querySelector<HTMLElement>(
      "[data-chat-thinking-preview-committed]",
    );
    if (committedLabel) {
      committedLabel.hidden = Boolean(preview);
    }
  };
  const resetSliderPreview = (input: HTMLInputElement, restoreValue = false) => {
    if (restoreValue) {
      input.value = String(sliderIndex);
    }
    syncSliderPreview(input);
  };
  const onSliderDrag = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const index = Number(input.value);
    if (sliderStops[index]) {
      syncSliderPreview(input, index);
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
          ultrafast ? "chat-controls__effort-trigger--ultrafast" : ""
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
            : html`<span class="chat-controls__effort-speed" aria-hidden="true">${icons.zap}</span>`
        }
        ${
          params.fastMode.active
            ? html`<span
                class="chat-controls__effort-zap ${
                  ultrafast ? "chat-controls__effort-zap--ultrafast" : ""
                }"
                aria-hidden="true"
              >
                ${ultrafast ? icons.zap : nothing}${icons.zap}
              </span>`
            : nothing
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
            showReasoning ? "chat.modelControls.effort" : "chat.modelControls.fastMode",
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
          ${
            params.fastMode.supported
              ? html`
                  <div class="chat-controls__speed-panel">
                    <span class="chat-controls__effort-heading"
                      >${t("chat.modelControls.speed")}</span
                    >
                    <div
                      class="chat-controls__speed-options"
                      role="radiogroup"
                      aria-label=${t("chat.modelControls.speed")}
                      @keydown=${onSpeedKeyDown}
                    >
                      ${speedOptions.map((option, index) => {
                        const selected = option.value === selectedSpeed;
                        return html`<button
                          type="button"
                          role="radio"
                          class="chat-controls__speed-option"
                          data-chat-speed-option=${option.value}
                          aria-checked=${String(selected)}
                          tabindex=${index === tabbableSpeedIndex ? "0" : "-1"}
                          ?disabled=${params.fastMode.disabled || option.disabled}
                          @click=${(event: MouseEvent) => {
                            event.stopPropagation();
                            if (
                              !params.fastMode.disabled &&
                              !option.disabled &&
                              option.value !== params.fastMode.currentOverride
                            ) {
                              commitFastMode(option.value);
                            }
                          }}
                        >
                          ${option.label}
                        </button>`;
                      })}
                    </div>
                  </div>
                `
              : nothing
          }
        </div>
      </wa-popup>
    </details>
  `;
}
