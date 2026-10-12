import { createEffect, createSignal, For } from "solid-js";
import {
  normalizeSessionIconValue,
  SESSION_COLOR_IDS,
  normalizeSessionColorValue,
  SESSION_ICON_GLYPH_IDS,
  SESSION_ICON_SVG_DATA_URL_PREFIX,
} from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { t } from "../i18n/index.ts";
import { nativeListener } from "../lib/solid-native-listener.ts";
import {
  SESSION_ICON_EMOJI_CHOICES as EMOJI_CHOICES,
  sessionEmojiPickerShortcut,
} from "./session-icon-choices.ts";
import { SessionIconGraphic } from "./session-icon-glyph-solid.tsx";
import { Icon } from "./solid/icon.tsx";
import { Kbd, ShortcutText } from "./solid/kbd.tsx";

type AppearancePickerProps = {
  inline?: boolean;
  allowSvg?: boolean;
  clearable?: boolean;
  mode: "grid" | "custom";
  currentIcon: string | null;
  currentColor: string | null;
  colorDisabled: boolean;
  colorDisabledReason?: string;
  onSelectColor: (event: MouseEvent, color: string | null) => void;
  onReset: (event: MouseEvent) => void;
  customIconValue: string;
  disabled: boolean;
  disabledReason?: string;
  onSelect: (event: MouseEvent, icon: string | null) => void;
  onShowCustom: (event: MouseEvent) => void;
  onBack: (event: Event) => void;
  onInput: (event: InputEvent) => void;
  onApply: (event: Event) => void;
};

function AppearancePicker(props: AppearancePickerProps) {
  const accepted = () => {
    const normalized = normalizeSessionIconValue(props.customIconValue);
    return (
      normalized && (props.allowSvg || !normalized.startsWith(SESSION_ICON_SVG_DATA_URL_PREFIX))
    );
  };
  const tabStop = () =>
    props.clearable !== false && props.currentIcon === null
      ? null
      : ([...EMOJI_CHOICES, ...SESSION_ICON_GLYPH_IDS].find((icon) => icon === props.currentIcon) ??
        EMOJI_CHOICES[0]);
  const choice = (icon: string | null, glyph = false) => (
    <button
      type="button"
      class={["session-menu__icon-choice", { "session-menu__icon-choice--glyph": glyph }]}
      aria-label={glyph ? (icon ?? t("sessionsView.noIcon")) : undefined}
      aria-pressed={props.currentIcon === icon ? "true" : "false"}
      tabindex={icon === tabStop() ? 0 : -1}
      disabled={props.disabled}
      title={props.disabledReason ?? (icon === null ? t("sessionsView.noIcon") : undefined)}
      ref={nativeListener("click", (event) => props.onSelect(event, icon))}
    >
      {icon === null ? <Icon name="circleX" /> : glyph ? <SessionIconGraphic icon={icon} /> : icon}
    </button>
  );
  return (
    <div slot={props.inline ? undefined : "submenu"} class="session-menu__appearance">
      <div class="session-menu__icon-section-label">{t("sessionsView.setColorMenu")}</div>
      <div class="session-menu__colors" role="group" aria-label={t("sessionsView.setColorMenu")}>
        <For each={props.clearable === false ? SESSION_COLOR_IDS : [null, ...SESSION_COLOR_IDS]}>
          {(color) => {
            const label = () =>
              color ? t(`sessionsView.colors.${color}`) : t("sessionsView.noColor");
            const selected = () =>
              normalizeSessionColorValue(props.currentColor ?? "") === color &&
              (color !== null || !props.currentColor);
            return (
              <button
                type="button"
                class="session-menu__color-choice"
                aria-label={label()}
                aria-pressed={selected() ? "true" : "false"}
                disabled={props.colorDisabled}
                title={props.colorDisabledReason ?? label()}
                ref={nativeListener("click", (event) => props.onSelectColor(event, color))}
              >
                <span
                  class={[
                    "session-menu__color-swatch",
                    { "session-menu__color-swatch--none": color === null },
                  ]}
                  style={color ? { background: `var(--session-color-${color})` } : undefined}
                  aria-hidden="true"
                >
                  {color === null ? (
                    <Icon name="circleX" />
                  ) : selected() ? (
                    <Icon name="check" />
                  ) : undefined}
                </span>
              </button>
            );
          }}
        </For>
      </div>
      <div class="session-menu__icon-picker session-menu__icon-panel" data-mode={props.mode}>
        <div
          class="session-menu__icon-options"
          aria-hidden={props.mode !== "grid" ? "true" : undefined}
          inert={props.mode !== "grid"}
          role="group"
          aria-label={t("sessionsView.setIconMenu")}
          ref={nativeListener("keydown", handleAppearanceGridKeydown)}
        >
          <div class="session-menu__icon-section-label">{t("sessionsView.iconEmojiSection")}</div>
          <div class="session-menu__icon-grid">
            <For each={EMOJI_CHOICES}>{(icon) => choice(icon)}</For>
            <button
              type="button"
              class="session-menu__icon-choice session-menu__icon-choice--custom"
              aria-label={t(
                props.allowSvg ? "sessionsView.customIconCell" : "sessionsView.customEmojiCell",
              )}
              aria-pressed="false"
              tabindex={-1}
              disabled={props.disabled}
              title={props.disabledReason}
              ref={nativeListener("click", (event) => props.onShowCustom(event))}
            >
              <Icon name="moreHorizontal" />
            </button>
          </div>
          <div class="session-menu__icon-section-label">{t("sessionsView.iconGlyphSection")}</div>
          <div class="session-menu__icon-grid">
            {props.clearable !== false ? choice(null, true) : undefined}
            <For each={SESSION_ICON_GLYPH_IDS}>{(icon) => choice(icon, true)}</For>
          </div>
        </div>
        <div
          class="session-menu__icon-custom-entry"
          aria-hidden={props.mode !== "custom" ? "true" : undefined}
          inert={props.mode !== "custom"}
        >
          <div class="session-menu__icon-custom-header">
            <button
              type="button"
              class="session-menu__icon-back"
              aria-label={t("common.back")}
              ref={nativeListener("click", (event) => props.onBack(event))}
            >
              <Icon name="arrowLeft" />
            </button>
            <span>
              {t(props.allowSvg ? "sessionsView.customIconTitle" : "sessionsView.customEmojiTitle")}
            </span>
          </div>
          <div class="session-menu__icon-custom-controls">
            <textarea
              class="session-menu__icon-custom-input"
              rows="1"
              autocomplete="off"
              aria-label={t(
                props.allowSvg ? "sessionsView.customIconTitle" : "sessionsView.customEmojiTitle",
              )}
              value={props.customIconValue}
              onInput={(event) => props.onInput(event)}
              ref={nativeListener("keydown", (event) => {
                if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                if (accepted() && !props.disabled) {
                  props.onApply(event);
                }
              })}
            />
            <button
              type="button"
              class="session-menu__icon-set"
              disabled={!accepted() || props.disabled}
              ref={nativeListener("click", (event) => props.onApply(event))}
            >
              {t("sessionsView.customEmojiSet")}
            </button>
          </div>
          <div class="session-menu__icon-custom-hint">
            {sessionEmojiPickerShortcut() ? (
              <ShortcutText
                text={t(
                  props.allowSvg ? "sessionsView.customIconHint" : "sessionsView.customEmojiHint",
                  { shortcut: "{shortcut}" },
                )}
                shortcut={() => <Kbd keys={sessionEmojiPickerShortcut()!} inline />}
              />
            ) : (
              t(
                props.allowSvg
                  ? "sessionsView.customIconHintNoShortcut"
                  : "sessionsView.customEmojiHintNoShortcut",
              )
            )}
          </div>
        </div>
      </div>
      {props.clearable !== false ? (
        <>
          <div class="session-menu__separator" role="separator" />
          <button
            type="button"
            class="session-menu__icon-remove"
            disabled={props.disabled || props.colorDisabled}
            title={props.disabledReason ?? props.colorDisabledReason}
            ref={nativeListener("click", (event) => props.onReset(event))}
          >
            {t("sessionsView.resetAppearance")}
          </button>
        </>
      ) : undefined}
    </div>
  );
}

function handleAppearanceGridKeydown(event: KeyboardEvent) {
  const choice = event.target;
  if (!(choice instanceof HTMLButtonElement)) {
    return;
  }
  const offset =
    event.key === "ArrowLeft" || event.key === "ArrowUp"
      ? -1
      : event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : undefined;
  if (offset === undefined || !(event.currentTarget instanceof HTMLElement)) {
    return;
  }
  const choices = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>(
      ".session-menu__icon-choice:not(:disabled)",
    ),
  );
  const index = choices.indexOf(choice);
  if (index < 0) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  let next = choices[(index + offset + choices.length) % choices.length];
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    const rows: { top: number; choices: { button: HTMLButtonElement; x: number }[] }[] = [];
    for (const button of choices) {
      const rect = button.getBoundingClientRect();
      const row = rows.find((candidate) => Math.abs(candidate.top - rect.top) < 1);
      const item = { button, x: rect.left + rect.width / 2 };
      if (row) {
        row.choices.push(item);
      } else {
        rows.push({ top: rect.top, choices: [item] });
      }
    }
    rows.sort((a, b) => a.top - b.top);
    const rowIndex = rows.findIndex((row) => row.choices.some((item) => item.button === choice));
    const targetRow = rows[(rowIndex + offset + rows.length) % rows.length];
    if (!targetRow) {
      return;
    }
    const rect = choice.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    next = targetRow.choices.reduce((nearest, item) =>
      Math.abs(item.x - x) < Math.abs(nearest.x - x) ? item : nearest,
    ).button;
  }
  choice.tabIndex = -1;
  if (next) {
    next.tabIndex = 0;
    next.focus();
  }
}

type AppearanceAction =
  | { kind: "set-icon"; icon: string | null }
  | { kind: "set-color"; color: string | null }
  | { kind: "reset-appearance" };
export function useSessionMenuAppearance(
  host: HTMLElement,
  readState: () => {
    session: { icon: string | null; color: string | null };
    actionDisabledReasons: Partial<Record<"set-icon" | "set-color", string>>;
  },
  actionDisabled: (kind: "set-icon" | "set-color") => boolean,
  runAction: (action: AppearanceAction) => void,
) {
  const [mode, setMode] = createSignal<"grid" | "custom">("grid");
  const [customValue, setCustomValue] = createSignal("");
  const [focusRequest, setFocusRequest] = createSignal<{
    target: "custom" | "grid" | "first";
    item?: HTMLElement;
  }>();
  createEffect(focusRequest, (request) => {
    if (request?.target === "custom") {
      host.querySelector<HTMLTextAreaElement>(".session-menu__icon-custom-input")?.focus();
    }
    if (request?.target === "grid") {
      const custom = host.querySelector<HTMLButtonElement>(".session-menu__icon-choice--custom");
      for (const choice of host.querySelectorAll<HTMLButtonElement>(".session-menu__icon-choice")) {
        choice.tabIndex = choice === custom ? 0 : -1;
      }
      custom?.focus();
    }
    if (request?.target === "first") {
      const frame = requestAnimationFrame(() =>
        request.item
          ?.querySelector<HTMLButtonElement>(".session-menu__appearance button:not(:disabled)")
          ?.focus(),
      );
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  });
  const prepare = () => {
    setMode("grid");
    setCustomValue("");
  };
  const showIconGrid = (event?: Event) => {
    event?.stopPropagation();
    prepare();
    setFocusRequest({ target: "grid" });
  };
  return {
    prepare,
    showIconGrid,
    focusOnOpen: (event: CustomEvent<{ item: HTMLElement }>) => {
      const item = event.currentTarget;
      if (
        !(item instanceof HTMLElement) ||
        event.detail.item !== item ||
        item.getAttribute("aria-expanded") === "true"
      ) {
        return;
      }
      prepare();
      setFocusRequest({ target: "first", item });
    },
    render: (inline = false) => (
      <AppearancePicker
        inline={inline}
        allowSvg
        mode={mode()}
        currentIcon={readState().session.icon}
        currentColor={readState().session.color}
        colorDisabled={actionDisabled("set-color")}
        colorDisabledReason={readState().actionDisabledReasons["set-color"]}
        onSelectColor={(event, color) => {
          event.stopPropagation();
          runAction({ kind: "set-color", color });
        }}
        onReset={(event) => {
          event.stopPropagation();
          runAction({ kind: "reset-appearance" });
        }}
        customIconValue={customValue()}
        disabled={actionDisabled("set-icon")}
        disabledReason={readState().actionDisabledReasons["set-icon"]}
        onSelect={(event, icon) => {
          event.stopPropagation();
          runAction({ kind: "set-icon", icon });
        }}
        onShowCustom={(event) => {
          event.stopPropagation();
          setMode("custom");
          setCustomValue("");
          setFocusRequest({ target: "custom" });
        }}
        onBack={showIconGrid}
        onInput={(event) => {
          if (event.currentTarget instanceof HTMLTextAreaElement) {
            setCustomValue(event.currentTarget.value);
          }
        }}
        onApply={(event) => {
          event.stopPropagation();
          const icon = normalizeSessionIconValue(customValue());
          if (icon) {
            runAction({ kind: "set-icon", icon });
          }
        }}
      />
    ),
  };
}
