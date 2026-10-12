import { For, createMemo } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/tooltip.ts";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import type {
  ChatFastModeSelectState,
  ChatFastModeSelectValue,
} from "../../../lib/chat/model-select-state.ts";
import type { ChatThinkingSelectState } from "../../../lib/chat/thinking.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { liveValue } from "../../../lib/reactive/live-value.ts";
import { handleChatComposerDetailsToggle, syncChatPickerOverlay } from "./chat-picker-overlay.ts";

registerEnglishCatalog(registerModelControlsEnglish);

export type ChatEffortPickerParams = {
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

function refreshAfterSelection(pending: Promise<unknown>, requestUpdate?: () => void) {
  void pending.finally(() => requestUpdate?.());
  requestUpdate?.();
}

export function ChatEffortPicker(props: ChatEffortPickerParams) {
  const view = createMemo(() => {
    const sliderStops = props.thinking.options;
    const showReasoning = sliderStops.length > 0;
    const selection = props.thinking.selection;
    const effortIsOff = selection.value === "off";
    const effortFraction =
      effortIsOff || selection.kind === "unanchored"
        ? 0
        : sliderStops.length > 1
          ? selection.index / (sliderStops.length - 1)
          : 1;
    const hasThinkingOverride = selection.source === "override";
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
    const defaultLevelLabel = formatEffortLabel(props.thinking.inherited.displayLabel);
    const reasoningValueText = formatEffortLabel(selection.displayLabel);
    const reasoningValueLabel = hasThinkingOverride
      ? reasoningValueText
      : t("chat.modelControls.defaultWithLevel", { level: defaultLevelLabel });
    const ultrafast = props.fastMode.currentOverride === "ultrafast";
    const speedLabel = ultrafast
      ? t("chat.modelControls.ultrafast")
      : props.fastMode.currentOverride === "auto"
        ? props.fastMode.label
        : t("chat.modelControls.fast");
    const triggerLabel = showReasoning ? reasoningValueText : t("chat.modelControls.speed");
    const triggerTitle = [
      showReasoning
        ? props.fastMode.active
          ? `${triggerLabel} · ${speedLabel}`
          : triggerLabel
        : `${triggerLabel}: ${props.fastMode.label}`,
      props.fastMode.hint,
    ]
      .filter(Boolean)
      .join(" · ");
    const speedOptions: { value: ChatFastModeSelectValue; label: string; disabled?: boolean }[] = [
      {
        value: props.fastMode.nextValue === "" ? "" : "off",
        label: t("chat.modelControls.standard"),
      },
      ...(props.fastMode.nextValue === ""
        ? []
        : [{ value: "on" as const, label: t("chat.modelControls.fast") }]),
      ...(props.fastMode.ultrafastSupported !== undefined || ultrafast
        ? [
            {
              value: "ultrafast" as const,
              label: t("chat.modelControls.ultrafast"),
              disabled: !props.fastMode.ultrafastSupported,
            },
          ]
        : []),
    ];
    const selectedSpeed =
      props.fastMode.currentOverride === "auto"
        ? "auto"
        : ultrafast
          ? "ultrafast"
          : props.fastMode.active
            ? "on"
            : "off";
    const selectedSpeedIndex = speedOptions.findIndex(
      (option) => option.value === selectedSpeed && !option.disabled,
    );
    return {
      sliderStops,
      showReasoning,
      effortIsOff,
      effortAngle: -120 + effortFraction * 240,
      hasThinkingOverride,
      selectedThinkingValue: hasThinkingOverride ? selection.value : "",
      sliderIndex,
      sliderUnanchored,
      sliderBoost,
      committedBoost,
      reasoningValueText,
      reasoningValueLabel,
      ultrafast,
      triggerLabel,
      triggerTitle,
      speedOptions,
      selectedSpeed,
      tabbableSpeedIndex:
        selectedSpeedIndex >= 0
          ? selectedSpeedIndex
          : speedOptions.findIndex((option) => !option.disabled),
      onlyStop: sliderStops.length === 1 ? sliderStops[0] : undefined,
      onlyStopSelected: selection.kind === "anchored" && selection.index === 0,
    };
  });
  const visible = () => props.reserved || view().showReasoning || props.fastMode.supported;
  // Catalog and status refreshes must not overwrite an uncommitted native drag.
  const committedSliderValue = createMemo(() => String(view().sliderIndex));
  const sliderFillPercent = (index: number, count: number) =>
    count > 1 ? (index / (count - 1)) * 100 : 0;
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
    const preview = previewIndex === undefined ? undefined : view().sliderStops[previewIndex];
    const index = previewIndex ?? view().sliderIndex;
    input.style.setProperty(
      "--reasoning-fill",
      `${sliderFillPercent(index, view().sliderStops.length)}%`,
    );
    input.dataset.effortBoost = preview ? view().sliderBoost(index) : view().committedBoost;
    input.setAttribute(
      "aria-valuetext",
      preview ? formatEffortLabel(preview.label) : view().reasoningValueLabel,
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
      input.value = String(view().sliderIndex);
    }
    syncSliderPreview(input);
  };
  const onSliderDrag = (event: Event) => {
    // SAFETY: This handler is registered only on the native range input.
    const input = event.currentTarget as HTMLInputElement;
    const index = Number(input.value);
    if (view().sliderStops[index]) {
      syncSliderPreview(input, index);
    }
  };
  const onSliderCommit = (event: Event) => {
    // SAFETY: Change, click, and keyboard commit all originate on the range input.
    const input = event.currentTarget as HTMLInputElement;
    const stop = view().sliderStops[Number(input.value)];
    resetSliderPreview(input);
    if (props.thinkingDisabled || !stop || stop.value === view().selectedThinkingValue) {
      return;
    }
    refreshAfterSelection(
      props.onThinkingSelect(stop.value, props.sessionKey),
      props.onRequestUpdate,
    );
  };
  return (
    <>
      {visible() && (
        <details
          class={[
            "chat-controls__inline-select chat-controls__effort-picker",
            {
              "chat-controls__effort-picker--reserved": props.reserved,
            },
          ]}
          aria-hidden={props.reserved === true ? "true" : "false"}
          inert={props.reserved === true}
          onToggle={(event: Event) => {
            // SAFETY: This toggle handler belongs to the surrounding native details.
            const details = event.currentTarget as HTMLDetailsElement;
            handleChatComposerDetailsToggle(event);
            syncChatPickerOverlay(details);
          }}
        >
          <summary
            class={[
              "chat-controls__inline-select-trigger chat-controls__effort-trigger",
              {
                "chat-controls__effort-trigger--ultrafast": view().ultrafast,
                "chat-controls__inline-select-trigger--disabled": props.disabled,
              },
            ]}
            data-chat-thinking-select="true"
            data-chat-thinking-value={view().selectedThinkingValue}
            data-chat-thinking-disabled={props.thinkingDisabled ? "true" : "false"}
            data-chat-fast-mode={props.fastMode.active ? "true" : "false"}
            aria-label={
              view().showReasoning
                ? `${t("chat.selectors.thinkingLevel")}: ${view().triggerTitle}`
                : view().triggerTitle
            }
            aria-disabled={props.disabled ? "true" : "false"}
            title={props.disabledReason ?? view().triggerTitle}
            onClick={(event: MouseEvent) => {
              if (props.disabled) {
                event.preventDefault();
              }
            }}
          >
            {view().showReasoning ? (
              <span
                class={[
                  "chat-controls__effort-gauge",
                  { "chat-controls__effort-gauge--off": view().effortIsOff },
                ]}
                aria-hidden="true"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path class="chat-controls__effort-gauge-dial" d="M3.34 17a10 10 0 1 1 17.32 0" />
                  <path
                    class="chat-controls__effort-gauge-needle"
                    d="M12 12V6"
                    style={{ transform: `rotate(${view().effortAngle}deg)` }}
                  />
                  <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
                </svg>
                {props.fastMode.active && (
                  <span class="chat-controls__effort-fast-badge">
                    <Icon name="zap" />
                  </span>
                )}
              </span>
            ) : (
              <span class="chat-controls__effort-speed" aria-hidden="true">
                <Icon name="zap" />
              </span>
            )}
            {props.fastMode.active && (
              <span
                class={[
                  "chat-controls__effort-zap",
                  { "chat-controls__effort-zap--ultrafast": view().ultrafast },
                ]}
                aria-hidden="true"
              >
                {view().ultrafast && <Icon name="zap" />}
                <Icon name="zap" />
              </span>
            )}
            <span class="chat-controls__inline-select-label">{view().triggerLabel}</span>
            <span class="chat-controls__inline-select-chevron" aria-hidden="true">
              <Icon name="chevronUp" />
            </span>
          </summary>
          <wa-popup data-anchored-overlay>
            <div
              class="chat-controls__inline-select-menu chat-controls__effort-menu"
              aria-label={t(
                view().showReasoning ? "chat.modelControls.effort" : "chat.modelControls.fastMode",
              )}
            >
              {view().showReasoning && (
                <div class="chat-controls__reasoning-panel">
                  <div class="chat-controls__reasoning-head">
                    <span class="chat-controls__effort-heading">
                      {t("chat.modelControls.effort")}
                    </span>
                    <span class="chat-controls__effort-value" aria-hidden="true">
                      <span data-chat-thinking-preview-committed>{view().reasoningValueText}</span>
                      <For each={view().sliderStops} keyed={(stop) => stop.value}>
                        {(stop, index) => (
                          <span data-chat-thinking-preview-index={index()} hidden>
                            {formatEffortLabel(stop().label)}
                          </span>
                        )}
                      </For>
                    </span>
                  </div>
                  {view().sliderStops.length > 1 ? (
                    <div class="chat-controls__reasoning-slider">
                      <div class="chat-controls__reasoning-dots" aria-hidden="true">
                        <For each={view().sliderStops} keyed={(stop) => stop.value}>
                          {(stop) => (
                            <span class="chat-controls__reasoning-dot" data-stop={stop().value} />
                          )}
                        </For>
                      </div>
                      <input
                        class={[
                          "chat-controls__reasoning-range",
                          {
                            "chat-controls__reasoning-range--inherit": !view().hasThinkingOverride,
                            "chat-controls__reasoning-range--unanchored": view().sliderUnanchored,
                          },
                        ]}
                        type="range"
                        min="0"
                        max={view().sliderStops.length - 1}
                        step="1"
                        ref={liveValue(committedSliderValue)}
                        style={{
                          "--reasoning-fill": `${sliderFillPercent(view().sliderIndex, view().sliderStops.length)}%`,
                        }}
                        data-chat-thinking-slider="true"
                        data-effort-boost={view().committedBoost}
                        data-chat-thinking-values={view()
                          .sliderStops.map((stop) => stop.value)
                          .join(",")}
                        aria-label={t("chat.selectors.thinkingLevel")}
                        aria-valuetext={view().reasoningValueLabel}
                        disabled={props.thinkingDisabled}
                        onInput={onSliderDrag}
                        onChange={onSliderCommit}
                        onClick={(event: MouseEvent) => {
                          if (
                            view().sliderUnanchored &&
                            // SAFETY: This click handler belongs to the range input.
                            Number((event.currentTarget as HTMLInputElement).value) ===
                              view().sliderIndex
                          ) {
                            onSliderCommit(event);
                          }
                        }}
                        onKeyDown={(event: KeyboardEvent) => {
                          if (
                            view().sliderUnanchored &&
                            ["Home", "ArrowLeft", "ArrowDown", "PageDown"].includes(event.key)
                          ) {
                            onSliderCommit(event);
                          }
                        }}
                        onPointerCancel={(event: PointerEvent) =>
                          // SAFETY: This cancellation handler belongs to the range input.
                          resetSliderPreview(event.currentTarget as HTMLInputElement, true)
                        }
                        onBlur={(event: FocusEvent) =>
                          // SAFETY: This blur handler belongs to the range input.
                          resetSliderPreview(event.currentTarget as HTMLInputElement, true)
                        }
                      />
                    </div>
                  ) : view().onlyStop ? (
                    <button
                      class={[
                        "chat-controls__reasoning-option",
                        { "chat-controls__reasoning-option--selected": view().onlyStopSelected },
                      ]}
                      data-chat-thinking-option={view().onlyStop?.value}
                      type="button"
                      aria-pressed={view().onlyStopSelected ? "true" : "false"}
                      disabled={props.thinkingDisabled}
                      onClick={(event: MouseEvent) => {
                        event.stopPropagation();
                        if (props.thinkingDisabled || view().onlyStopSelected) {
                          event.preventDefault();
                          return;
                        }
                        const stop = view().onlyStop;
                        if (stop) {
                          refreshAfterSelection(
                            props.onThinkingSelect(stop.value, props.sessionKey),
                            props.onRequestUpdate,
                          );
                        }
                      }}
                    >
                      <span>{view().onlyStop?.label}</span>
                      {view().onlyStopSelected && (
                        <span class="chat-controls__inline-select-check" aria-hidden="true">
                          <Icon name="check" />
                        </span>
                      )}
                    </button>
                  ) : undefined}
                </div>
              )}
              {props.fastMode.supported && (
                <div class="chat-controls__speed-panel">
                  <span class="chat-controls__effort-heading">{t("chat.modelControls.speed")}</span>
                  <div
                    class="chat-controls__speed-options"
                    role="radiogroup"
                    aria-label={t("chat.modelControls.speed")}
                    onKeyDown={onSpeedKeyDown}
                  >
                    <For each={view().speedOptions} keyed={(option) => option.value}>
                      {(option, index) => (
                        <button
                          type="button"
                          role="radio"
                          class="chat-controls__speed-option"
                          data-chat-speed-option={option().value}
                          aria-checked={option().value === view().selectedSpeed ? "true" : "false"}
                          tabindex={index() === view().tabbableSpeedIndex ? 0 : -1}
                          disabled={props.fastMode.disabled || option().disabled}
                          onClick={(event: MouseEvent) => {
                            event.stopPropagation();
                            if (
                              !props.fastMode.disabled &&
                              !option().disabled &&
                              option().value !== props.fastMode.currentOverride
                            ) {
                              refreshAfterSelection(
                                props.onFastModeSelect(option().value, props.sessionKey),
                                props.onRequestUpdate,
                              );
                            }
                          }}
                        >
                          {option().label}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              )}
            </div>
          </wa-popup>
        </details>
      )}
    </>
  );
}
