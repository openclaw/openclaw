import { For, createMemo } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { ChatFastModeSelectValue } from "../../../lib/chat/model-select-state.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { liveValue } from "../../../lib/reactive/live-value.ts";
import { formatEffortLabel, type ChatEffortPickerParams } from "./chat-effort-picker.tsx";

type ChatEffortPickerPanelProps = Pick<
  ChatEffortPickerParams,
  "fastMode" | "sessionKey" | "thinkingDisabled" | "onFastModeSelect" | "onThinkingSelect"
> & {
  view: {
    sliderStops: ChatEffortPickerParams["thinking"]["options"];
    showReasoning: boolean;
    hasThinkingOverride: boolean;
    selectedThinkingValue: string;
    sliderIndex: number;
    sliderUnanchored: boolean;
    sliderBoost: (index: number) => string;
    committedBoost: string;
    reasoningValueText: string;
    reasoningValueLabel: string;
    speedOptions: { value: ChatFastModeSelectValue; label: string; disabled?: boolean }[];
    selectedSpeed: string;
    tabbableSpeedIndex: number;
    onlyStop: ChatEffortPickerParams["thinking"]["options"][number] | undefined;
    onlyStopSelected: boolean;
  };
};

export function ChatEffortPickerPanel(props: ChatEffortPickerPanelProps) {
  const view = () => props.view;
  const speedButtons = new Set<HTMLButtonElement>();
  const previewLabels = new Set<HTMLSpanElement>();
  let committedLabel: HTMLSpanElement | undefined;
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
    const options = [...speedButtons]
      .filter((button) => !button.disabled)
      .toSorted((left, right) =>
        left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      );
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
    for (const label of previewLabels) {
      label.hidden = !preview || label.dataset.chatThinkingPreviewIndex !== input.value;
    }
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
    void props.onThinkingSelect(stop.value, props.sessionKey);
  };
  return (
    <div
      class="chat-controls__inline-select-menu chat-controls__effort-menu"
      aria-label={t(
        view().showReasoning ? "chat.modelControls.effort" : "chat.modelControls.fastMode",
      )}
    >
      {view().showReasoning && (
        <div class="chat-controls__reasoning-panel">
          <div class="chat-controls__reasoning-head">
            <span class="chat-controls__effort-heading">{t("chat.modelControls.effort")}</span>
            <span class="chat-controls__effort-value" aria-hidden="true">
              <span
                ref={(element) => (committedLabel = element)}
                data-chat-thinking-preview-committed
              >
                {view().reasoningValueText}
              </span>
              <For each={view().sliderStops} keyed={(stop) => stop.value}>
                {(stop, index) => (
                  <span
                    ref={elementRef<HTMLSpanElement>((element) => {
                      previewLabels.add(element);
                      return () => previewLabels.delete(element);
                    })}
                    data-chat-thinking-preview-index={index()}
                    hidden
                  >
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
                  {(stop) => <span class="chat-controls__reasoning-dot" data-stop={stop().value} />}
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
                    Number((event.currentTarget as HTMLInputElement).value) === view().sliderIndex
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
                {
                  "chat-controls__reasoning-option--selected": view().onlyStopSelected,
                },
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
                  void props.onThinkingSelect(stop.value, props.sessionKey);
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
                  ref={elementRef<HTMLButtonElement>((element) => {
                    speedButtons.add(element);
                    return () => speedButtons.delete(element);
                  })}
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
                      option().value !== props.fastMode.persistedOverride
                    ) {
                      void props.onFastModeSelect(option().value, props.sessionKey);
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
  );
}
