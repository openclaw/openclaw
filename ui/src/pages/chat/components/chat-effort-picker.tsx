import { Show, createMemo, createSignal, createUniqueId, lazy } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { StrokeIcon } from "../../../components/solid/stroke-icon.tsx";
import "../../../components/tooltip.ts";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import type {
  ChatFastModeSelectState,
  ChatFastModeSelectValue,
} from "../../../lib/chat/model-select-state.ts";
import type { ChatThinkingSelectState } from "../../../lib/chat/thinking.ts";
import { warmWhenIdle } from "../../../lib/idle-warmup.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ChatAccessProgramControlProps } from "./chat-access-program-control.tsx";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import { createChatPickerOverlay } from "./chat-picker-overlay.ts";

registerEnglishCatalog(registerModelControlsEnglish);

const EFFORT_GAUGE_PATH = "M3.34 17a10 10 0 1 1 17.32 0";

const ChatEffortPickerPanel = lazy(() => import("./chat-effort-picker-panel.tsx"), {
  export: "ChatEffortPickerPanel",
});
warmWhenIdle(ChatEffortPickerPanel.preload);

export type ChatEffortPickerParams = {
  accessProgram?: ChatAccessProgramControlProps;
  disabled: boolean;
  disabledReason?: string;
  fastMode: ChatFastModeSelectState;
  sessionKey: string;
  thinkingDisabled: boolean;
  thinking: ChatThinkingSelectState;
  onFastModeSelect: (value: ChatFastModeSelectValue, sessionKey: string) => Promise<unknown>;
  onThinkingSelect: (value: string, sessionKey: string) => Promise<unknown>;
  reserved?: boolean;
};

export function formatEffortLabel(label: string): string {
  return label.replace(/^Inherited:\s*/u, "");
}

export function ChatEffortPicker(props: ChatEffortPickerParams) {
  const gradientId = `chat-effort-gradient-${createUniqueId()}`;
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
    return {
      sliderStops,
      showReasoning,
      effortIsOff,
      effortIsUltra: selection.kind === "anchored" && selection.value === "ultra",
      effortFraction,
      effortAngle: -120 + effortFraction * 240,
      hasThinkingOverride,
      selectedThinkingValue: hasThinkingOverride ? selection.value : "",
      sliderIndex,
      sliderUnanchored,
      reasoningValueText,
      reasoningValueLabel,
      ultrafast,
      triggerLabel,
      triggerTitle,
      speedOptions,
      selectedSpeed,
      onlyStop: sliderStops.length === 1 ? sliderStops[0] : undefined,
      onlyStopSelected: selection.kind === "anchored" && selection.index === 0,
    };
  });
  const visible = () =>
    props.reserved ||
    view().showReasoning ||
    props.fastMode.supported ||
    props.accessProgram !== undefined;
  return (
    <Show when={visible()}>
      {(_visible) => {
        const [open, setOpen] = createSignal(false);
        const pickerOverlay = createChatPickerOverlay((details) => setOpen(details.open));
        return (
          <details
            ref={pickerOverlay.details}
            onClick={pickerOverlay.onClick}
            onToggle={pickerOverlay.onToggle}
            class={[
              "chat-controls__inline-select chat-controls__effort-picker",
              {
                "chat-controls__effort-picker--reserved": props.reserved,
              },
            ]}
            aria-hidden={props.reserved === true ? "true" : "false"}
            inert={props.reserved === true}
          >
            <summary
              ref={pickerOverlay.trigger}
              class={[
                "chat-controls__inline-select-trigger chat-controls__effort-trigger",
                {
                  "chat-controls__effort-trigger--ultrafast": view().ultrafast,
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
              aria-description={props.disabledReason}
              title={props.disabledReason ?? view().triggerTitle}
            >
              {view().showReasoning ? (
                <span
                  class={[
                    "chat-controls__effort-gauge",
                    {
                      "chat-controls__effort-gauge--off": view().effortIsOff,
                    },
                  ]}
                  aria-hidden="true"
                >
                  <StrokeIcon>
                    <defs>
                      <linearGradient
                        id={gradientId}
                        x1="2"
                        y1="12"
                        x2="22"
                        y2="12"
                        gradientUnits="userSpaceOnUse"
                      >
                        <stop
                          offset="0"
                          stop-color="color-mix(in oklab, var(--accent) 45%, white)"
                        />
                        <stop offset="1" stop-color="var(--accent)" />
                      </linearGradient>
                    </defs>
                    <path class="chat-controls__effort-gauge-dial" d={EFFORT_GAUGE_PATH} />
                    <path
                      class="chat-controls__effort-gauge-progress"
                      d={EFFORT_GAUGE_PATH}
                      pathLength="1"
                      stroke={view().effortIsUltra ? `url(#${gradientId})` : "var(--muted)"}
                      stroke-dasharray={`${view().effortFraction} 1`}
                      stroke-opacity={view().effortFraction > 0 ? "1" : "0"}
                    />
                    {props.fastMode.active && view().effortFraction === 0 && (
                      <circle cx="3.34" cy="17" r="1" fill="var(--muted)" stroke="none" />
                    )}
                    {!props.fastMode.active && (
                      <>
                        <path
                          class="chat-controls__effort-gauge-needle"
                          d="M12 12V6"
                          style={{ transform: `rotate(${view().effortAngle}deg)` }}
                        />
                        <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
                      </>
                    )}
                  </StrokeIcon>
                  {props.fastMode.active && (
                    <span
                      class={[
                        "chat-controls__effort-fast-badge",
                        {
                          "chat-controls__effort-zap--ultrafast": view().ultrafast,
                        },
                      ]}
                    >
                      <Icon name={view().ultrafast ? "zapDouble" : "zap"} />
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
                  <Icon name={view().ultrafast ? "zapDouble" : "zap"} />
                </span>
              )}
              <span class="chat-controls__inline-select-label">{view().triggerLabel}</span>
              <span class="chat-controls__inline-select-chevron" aria-hidden="true">
                <Icon name="chevronUp" />
              </span>
            </summary>
            <div
              ref={pickerOverlay.surface}
              class="oc-overlay chat-picker-overlay"
              data-anchored-overlay
              popover="manual"
            >
              <Show when={open()}>
                <ChatLazyBoundary>
                  <ChatEffortPickerPanel
                    view={view()}
                    accessProgram={props.accessProgram}
                    fastMode={props.fastMode}
                    sessionKey={props.sessionKey}
                    thinkingDisabled={props.thinkingDisabled}
                    onFastModeSelect={props.onFastModeSelect}
                    onThinkingSelect={props.onThinkingSelect}
                  />
                </ChatLazyBoundary>
              </Show>
            </div>
          </details>
        );
      }}
    </Show>
  );
}
