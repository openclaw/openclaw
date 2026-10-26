import { For, createMemo, onSettled } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { ChatFastModeSelectValue } from "../../../lib/chat/model-select-state.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { liveValue } from "../../../lib/reactive/live-value.ts";
import { createMediaQuerySource } from "../../../lib/reactive/platform.ts";
import { ChatAccessProgramControl } from "./chat-access-program-control.tsx";
import { formatEffortLabel, type ChatEffortPickerParams } from "./chat-effort-picker.tsx";
import { ChatPreferenceSegments } from "./chat-preference-segments.tsx";

type ChatEffortPickerPanelProps = Pick<
  ChatEffortPickerParams,
  | "accessProgram"
  | "fastMode"
  | "sessionKey"
  | "thinkingDisabled"
  | "onFastModeSelect"
  | "onThinkingSelect"
> & {
  view: {
    sliderStops: ChatEffortPickerParams["thinking"]["options"];
    showReasoning: boolean;
    hasThinkingOverride: boolean;
    selectedThinkingValue: string;
    sliderIndex: number;
    sliderUnanchored: boolean;
    reasoningValueText: string;
    reasoningValueLabel: string;
    speedOptions: { value: ChatFastModeSelectValue; label: string; disabled?: boolean }[];
    selectedSpeed: string;
    onlyStop: ChatEffortPickerParams["thinking"]["options"][number] | undefined;
    onlyStopSelected: boolean;
  };
};

export function ChatEffortPickerPanel(props: ChatEffortPickerPanelProps) {
  const view = () => props.view;
  const previewLabels = new Set<HTMLSpanElement>();
  const notchElements = new Set<HTMLSpanElement>();
  let committedLabel: HTMLSpanElement | undefined;
  let valueLabel: HTMLSpanElement | undefined;
  let slider: HTMLDivElement | undefined;
  let sweep: HTMLSpanElement | undefined;
  let glow: HTMLSpanElement | undefined;
  let previewIndex: number | undefined;
  let dragging = false;
  let pointerCommitted = false;
  let valueAnimation: Animation | undefined;
  let sweepAnimation: Animation | undefined;
  let glowAnimation: Animation | undefined;
  const reducedMotion = createMediaQuerySource("(prefers-reduced-motion: reduce)");
  const cancelMotion = () => {
    valueAnimation?.cancel();
    sweepAnimation?.cancel();
    glowAnimation?.cancel();
    valueAnimation = sweepAnimation = glowAnimation = undefined;
  };
  onSettled(() => reducedMotion.subscribe((reduce) => reduce && cancelMotion()));
  const fadeUltra = () => {
    const fade = (element: HTMLElement | undefined, animation: Animation | undefined) => {
      if (!element || !animation || animation.playState === "finished") {
        return undefined;
      }
      // Freeze the current light and halo before fading; cancelling first would snap to zero.
      const { opacity, transform, boxShadow } = getComputedStyle(element);
      animation.cancel();
      return element.animate(
        [
          { opacity, transform, boxShadow },
          { opacity: 0, transform, boxShadow },
        ],
        { duration: 120, easing: "ease-out" },
      );
    };
    sweepAnimation = fade(sweep, sweepAnimation);
    glowAnimation = fade(glow, glowAnimation);
  };
  const animateChange = (previous: number, next: number) => {
    if (reducedMotion.read()) {
      cancelMotion();
      return;
    }
    if (previous === next) {
      return;
    }
    if (
      view().sliderStops[previous]?.value === "ultra" &&
      view().sliderStops[next]?.value !== "ultra"
    ) {
      fadeUltra();
    }
    if (!dragging && valueLabel) {
      valueAnimation?.cancel();
      valueAnimation = valueLabel.animate(
        [
          { transform: `translateY(${next > previous ? 6 : -6}px)`, opacity: 0 },
          { transform: "translateY(0)", opacity: 1 },
        ],
        { duration: 160, easing: "ease-out" },
      );
    }
    if (
      view().sliderStops[next]?.value === "ultra" &&
      view().sliderStops[previous]?.value !== "ultra"
    ) {
      sweepAnimation?.cancel();
      glowAnimation?.cancel();
      sweepAnimation = sweep?.animate(
        [
          { transform: "translateX(-100%)", easing: "cubic-bezier(.3, 0, .6, .6)" },
          { transform: "translateX(-50%)", offset: 0.16 },
          { transform: "translateX(20%)", offset: 1 / 3 },
          { transform: "translateX(70%)", offset: 7 / 15 },
          { transform: "translateX(120%)", offset: 2 / 3 },
          { transform: "translateX(200%)", offset: 13 / 15, easing: "ease-out" },
          { transform: "translateX(210%)" },
        ],
        { duration: 750 },
      );
      const halo = (blur: number) => `0 0 ${blur}px var(--reasoning-glow-color)`;
      glowAnimation = glow?.animate(
        [
          { boxShadow: halo(0), opacity: 0, easing: "ease-out" },
          { boxShadow: halo(18), opacity: 1, offset: 0.3, easing: "ease-out" },
          { boxShadow: halo(0), opacity: 0 },
        ],
        { duration: 900 },
      );
    }
  };
  // Catalog and status refreshes must not overwrite an uncommitted native drag.
  const committedSliderValue = createMemo(() => String(view().sliderIndex));
  const sliderFraction = (index: number, count: number) => (count > 1 ? index / (count - 1) : 0);
  const syncSliderPreview = (
    input: HTMLInputElement,
    nextIndex?: number,
    position = nextIndex ?? view().sliderIndex,
  ) => {
    const preview = nextIndex === undefined ? undefined : view().sliderStops[nextIndex];
    const index = nextIndex ?? view().sliderIndex;
    slider?.style.setProperty(
      "--reasoning-fill",
      String(sliderFraction(position, view().sliderStops.length)),
    );
    if (valueLabel) {
      valueLabel.dataset.inherited = String(!preview && !view().hasThinkingOverride);
    }
    input.setAttribute(
      "aria-valuetext",
      preview ? formatEffortLabel(preview.label) : view().reasoningValueLabel,
    );
    for (const label of previewLabels) {
      label.hidden = !preview || Number(label.dataset.chatThinkingPreviewIndex) !== index;
    }
    if (committedLabel) {
      committedLabel.hidden = Boolean(preview);
    }
    for (const notch of notchElements) {
      notch.toggleAttribute(
        "data-filled",
        Boolean(preview || !view().sliderUnanchored) &&
          Number(notch.dataset.chatThinkingStopIndex) <= position,
      );
    }
  };
  const resetSliderPreview = (input: HTMLInputElement, restoreValue = false) => {
    if (
      restoreValue &&
      previewIndex !== undefined &&
      view().sliderStops[previewIndex]?.value === "ultra" &&
      view().sliderStops[view().sliderIndex]?.value !== "ultra"
    ) {
      fadeUltra();
    }
    previewIndex = undefined;
    if (restoreValue) {
      input.value = String(view().sliderIndex);
    }
    syncSliderPreview(input);
  };
  const onSliderDrag = (event: Event) => {
    // SAFETY: This handler is registered only on the native range input.
    const input = event.currentTarget as HTMLInputElement;
    const position = Number(input.value);
    const index = Math.round(position);
    if (view().sliderStops[index]) {
      const previous = previewIndex ?? view().sliderIndex;
      previewIndex = index;
      syncSliderPreview(input, index, position);
      animateChange(previous, index);
    }
  };
  const onSliderCommit = (event: Event) => {
    // SAFETY: Change, click, and keyboard commit all originate on the range input.
    const input = event.currentTarget as HTMLInputElement;
    const index = Math.round(Number(input.value));
    const stop = view().sliderStops[index];
    input.value = String(index);
    animateChange(previewIndex ?? view().sliderIndex, index);
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
      {props.accessProgram && <ChatAccessProgramControl {...props.accessProgram} />}
      {view().showReasoning && (
        <div class="chat-controls__reasoning-panel">
          <div class="chat-controls__reasoning-head">
            <span class="chat-controls__effort-heading">{t("chat.modelControls.effort")}</span>
            <span
              ref={(element) => (valueLabel = element)}
              class="chat-controls__effort-value"
              data-inherited={!view().hasThinkingOverride ? "true" : "false"}
              aria-hidden="true"
            >
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
            <div
              ref={elementRef<HTMLDivElement>((element) => {
                slider = element;
                return cancelMotion;
              })}
              class="chat-controls__reasoning-slider"
              style={{
                "--reasoning-fill": sliderFraction(view().sliderIndex, view().sliderStops.length),
              }}
            >
              <span
                ref={(element) => (glow = element)}
                class="chat-controls__reasoning-glow"
                aria-hidden="true"
              />
              <div class="chat-controls__reasoning-track" aria-hidden="true">
                <div class="chat-controls__reasoning-fill">
                  <span
                    ref={(element) => (sweep = element)}
                    class="chat-controls__reasoning-sweep"
                  />
                </div>
              </div>
              <div class="chat-controls__reasoning-dots" aria-hidden="true">
                <For each={view().sliderStops} keyed={(stop) => stop.value}>
                  {(stop, index) => (
                    <span
                      ref={elementRef<HTMLSpanElement>((element) => {
                        notchElements.add(element);
                        return () => notchElements.delete(element);
                      })}
                      class="chat-controls__reasoning-dot"
                      data-stop={stop().value}
                      data-chat-thinking-stop-index={index()}
                      data-filled={
                        !view().sliderUnanchored && index() <= view().sliderIndex ? "" : undefined
                      }
                    />
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
                step="any"
                ref={liveValue(committedSliderValue)}
                data-chat-thinking-slider="true"
                data-chat-thinking-values={view()
                  .sliderStops.map((stop) => stop.value)
                  .join(",")}
                aria-label={t("chat.selectors.thinkingLevel")}
                aria-valuetext={view().reasoningValueLabel}
                disabled={props.thinkingDisabled}
                onPointerDown={() => {
                  dragging = false;
                  pointerCommitted = false;
                }}
                onPointerMove={(event: PointerEvent) => {
                  if (event.buttons) {
                    dragging = true;
                    valueAnimation?.cancel();
                  }
                }}
                onInput={onSliderDrag}
                onChange={(event: Event) => {
                  pointerCommitted = true;
                  onSliderCommit(event);
                }}
                onClick={(event: MouseEvent) => {
                  if (
                    view().sliderUnanchored &&
                    !pointerCommitted &&
                    // SAFETY: This click handler belongs to the range input.
                    Number((event.currentTarget as HTMLInputElement).value) === view().sliderIndex
                  ) {
                    onSliderCommit(event);
                  }
                }}
                onKeyDown={(event) => {
                  dragging = false;
                  if (props.thinkingDisabled) {
                    return;
                  }
                  const input = event.currentTarget;
                  const current = Math.round(Number(input.value));
                  const last = view().sliderStops.length - 1;
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? last
                        : ["ArrowRight", "ArrowUp", "PageUp"].includes(event.key)
                          ? Math.min(last, current + 1)
                          : ["ArrowLeft", "ArrowDown", "PageDown"].includes(event.key)
                            ? Math.max(0, current - 1)
                            : undefined;
                  if (next === undefined) {
                    return;
                  }
                  event.preventDefault();
                  input.value = String(next);
                  onSliderDrag(event);
                  onSliderCommit(event);
                }}
                onPointerCancel={(event: PointerEvent) => {
                  cancelMotion();
                  // SAFETY: This cancellation handler belongs to the range input.
                  resetSliderPreview(event.currentTarget as HTMLInputElement, true);
                }}
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
        <div class="chat-controls__speed-panel chat-controls__speed-panel--inline">
          <span class="chat-controls__effort-heading">{t("chat.modelControls.speed")}</span>
          <ChatPreferenceSegments
            kind="speed"
            label={t("chat.modelControls.speed")}
            options={view().speedOptions}
            selected={view().selectedSpeed}
            disabled={props.fastMode.disabled}
            onSelect={(value) => {
              if (value !== props.fastMode.persistedOverride) {
                void props.onFastModeSelect(value, props.sessionKey);
              }
            }}
          />
        </div>
      )}
    </div>
  );
}
