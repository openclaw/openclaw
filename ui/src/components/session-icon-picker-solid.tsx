import { createMemo, createSignal, For, onSettled } from "solid-js";
import {
  normalizeSessionIconValue,
  SESSION_COLOR_IDS,
  normalizeSessionColorValue,
  SESSION_ICON_GLYPH_IDS,
  SESSION_ICON_SVG_DATA_URL_PREFIX,
} from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { registerSessionOrganizationEnglish } from "../i18n/locales/en-session-organization.ts";
import { t } from "../lib/reactive/i18n.ts";
import { nativeListener } from "../lib/solid-native-listener.ts";
import {
  SESSION_ICON_EMOJI_CHOICES as EMOJI_CHOICES,
  sessionEmojiPickerShortcut,
} from "./session-icon-choices.ts";
import { SessionIconGraphic } from "./session-icon-glyph-solid.tsx";
import { Icon } from "./solid/icon.tsx";
import { Kbd, ShortcutText } from "./solid/kbd.tsx";

registerSessionOrganizationEnglish();

export type AppearancePickerFocus = (target: "first" | "grid" | "custom", roving?: boolean) => void;

export type AppearancePickerProps = {
  mobile?: boolean;
  sessionLabel?: string;
  ref?: (handle: AppearancePickerFocus) => void;
  controlRef?: () => (element: HTMLElement) => void;
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
  onInput: (event: InputEvent & { currentTarget: HTMLTextAreaElement }) => void;
  onApply: (event: Event) => void;
};

export function AppearancePicker(props: AppearancePickerProps) {
  const choices = new Map<string | null, HTMLButtonElement>();
  const colors = new Map<string | null, HTMLButtonElement>();
  let custom: HTMLButtonElement | undefined;
  let input: HTMLTextAreaElement | undefined;
  onSettled(() => {
    props.ref?.((target, roving) =>
      onSettled(() => {
        if (target === "first") {
          [...colors.values(), ...choices.values()]
            .find((button) => button.isConnected && !button.disabled)
            ?.focus();
          return;
        }
        if (target === "grid" && roving) {
          for (const button of choices.values()) {
            button.tabIndex = button === custom ? 0 : -1;
          }
        }
        (target === "grid" ? custom : input)?.focus();
      }),
    );
  });
  const accepted = () => {
    const normalized = normalizeSessionIconValue(props.customIconValue);
    return (
      normalized && (props.allowSvg || !normalized.startsWith(SESSION_ICON_SVG_DATA_URL_PREFIX))
    );
  };
  const tabStop = createMemo(() =>
    props.clearable !== false && props.currentIcon === null
      ? null
      : ([...EMOJI_CHOICES, ...SESSION_ICON_GLYPH_IDS].find((icon) => icon === props.currentIcon) ??
        EMOJI_CHOICES[0]),
  );
  const choice = (icon: string | null, glyph = false) => (
    <button
      type="button"
      class={["session-menu__icon-choice", { "session-menu__icon-choice--glyph": glyph }]}
      data-form-control
      aria-label={glyph ? (icon ?? t("sessionsView.noIcon")) : undefined}
      aria-pressed={props.currentIcon === icon ? "true" : "false"}
      tabindex={icon === tabStop() ? 0 : -1}
      disabled={props.disabled}
      title={props.disabledReason ?? (icon === null ? t("sessionsView.noIcon") : undefined)}
      ref={[
        props.controlRef?.(),
        (element) => choices.set(icon, element),
        nativeListener("click", (event) => props.onSelect(event, icon)),
      ]}
    >
      {icon === null ? <Icon name="circleX" /> : glyph ? <SessionIconGraphic icon={icon} /> : icon}
    </button>
  );
  return (
    <div class={["session-menu__appearance", { "session-menu__appearance--mobile": props.mobile }]}>
      {props.mobile && (
        <div class="session-menu__appearance-identity">
          <span>
            {props.currentIcon ? (
              props.currentIcon.startsWith(SESSION_ICON_SVG_DATA_URL_PREFIX) ||
              SESSION_ICON_GLYPH_IDS.some((id) => id === props.currentIcon) ? (
                <SessionIconGraphic icon={props.currentIcon} />
              ) : (
                props.currentIcon
              )
            ) : (
              <Icon name="circleX" />
            )}
          </span>
          <span>{props.sessionLabel}</span>
        </div>
      )}
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
                data-form-control
                data-initial-focus={
                  color === (props.clearable === false ? SESSION_COLOR_IDS[0] : null)
                    ? ""
                    : undefined
                }
                aria-label={label()}
                aria-pressed={selected() ? "true" : "false"}
                disabled={props.colorDisabled}
                title={props.colorDisabledReason ?? label()}
                ref={[
                  props.controlRef?.(),
                  (element) => colors.set(color, element),
                  nativeListener("click", (event) => props.onSelectColor(event, color)),
                ]}
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
          aria-hidden={!props.mobile && props.mode !== "grid" ? "true" : undefined}
          inert={!props.mobile && props.mode !== "grid"}
          role="group"
          aria-label={t("sessionsView.setIconMenu")}
          ref={nativeListener("keydown", (event) =>
            handleAppearanceGridKeydown(
              event,
              [...choices.values()]
                .filter((button) => button.isConnected && !button.disabled)
                .toSorted((a, b) =>
                  a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
                ),
            ),
          )}
        >
          <div class="session-menu__icon-section-label">{t("sessionsView.iconEmojiSection")}</div>
          <div class="session-menu__icon-grid">
            <For each={EMOJI_CHOICES}>{(icon) => choice(icon)}</For>
            <button
              type="button"
              class="session-menu__icon-choice session-menu__icon-choice--custom"
              data-form-control
              aria-label={t(
                props.allowSvg ? "sessionsView.customIconCell" : "sessionsView.customEmojiCell",
              )}
              aria-pressed="false"
              tabindex={-1}
              disabled={props.disabled}
              title={props.disabledReason}
              ref={[
                props.controlRef?.(),
                (element) => choices.set("", (custom = element)),
                nativeListener("click", (event) => props.onShowCustom(event)),
              ]}
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
          aria-hidden={!props.mobile && props.mode !== "custom" ? "true" : undefined}
          inert={!props.mobile && props.mode !== "custom"}
        >
          <div class="session-menu__icon-custom-header">
            <button
              type="button"
              class="session-menu__icon-back"
              data-form-control
              aria-label={t("common.back")}
              ref={[props.controlRef?.(), nativeListener("click", (event) => props.onBack(event))]}
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
              placeholder={
                props.mobile
                  ? t(
                      props.allowSvg
                        ? "sessionsView.customIconHintNoShortcut"
                        : "sessionsView.customEmojiHintNoShortcut",
                    )
                  : undefined
              }
              data-form-control
              rows="1"
              autocomplete="off"
              aria-label={t(
                props.allowSvg ? "sessionsView.customIconTitle" : "sessionsView.customEmojiTitle",
              )}
              value={props.customIconValue}
              onInput={(event) => props.onInput(event)}
              ref={[
                props.controlRef?.(),
                (element) => (input = element),
                nativeListener("keydown", (event) => {
                  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  if (accepted() && !props.disabled) {
                    props.onApply(event);
                  }
                }),
              ]}
            />
            <button
              type="button"
              class="session-menu__icon-set"
              data-form-control
              disabled={!accepted() || props.disabled}
              ref={[props.controlRef?.(), nativeListener("click", (event) => props.onApply(event))]}
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
            data-form-control
            disabled={props.disabled || props.colorDisabled}
            title={props.disabledReason ?? props.colorDisabledReason}
            ref={[props.controlRef?.(), nativeListener("click", (event) => props.onReset(event))]}
          >
            {props.mobile && <Icon name="rotateCcw" />}
            {t("sessionsView.resetAppearance")}
          </button>
        </>
      ) : undefined}
    </div>
  );
}

function handleAppearanceGridKeydown(event: KeyboardEvent, choices: HTMLButtonElement[]) {
  const choice = event.target;
  const offset =
    event.key === "ArrowLeft" || event.key === "ArrowUp"
      ? -1
      : event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : undefined;
  if (offset === undefined || !(choice instanceof HTMLButtonElement)) {
    return;
  }
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
  readState: () => {
    session: { icon: string | null; color: string | null; label?: string };
    actionDisabledReasons: Partial<Record<"set-icon" | "set-color", string>>;
  },
  actionDisabled: (kind: "set-icon" | "set-color") => boolean,
  runAction: (action: AppearanceAction) => void,
  controlRef?: () => (element: HTMLElement) => void,
) {
  const [mode, setMode] = createSignal<"grid" | "custom">("grid");
  const [customValue, setCustomValue] = createSignal("");
  let focus: AppearancePickerFocus | undefined;
  const prepare = () => {
    setMode("grid");
    setCustomValue("");
  };
  const showIconGrid = (event?: Event) => {
    event?.stopPropagation();
    prepare();
    focus?.("grid", true);
  };
  return {
    prepare,
    focusFirst: () => focus?.("first"),
    showIconGrid,
    render: (mobile = false) => (
      <AppearancePicker
        controlRef={controlRef}
        mobile={mobile}
        sessionLabel={readState().session.label}
        ref={(handle) => (focus = handle)}
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
          focus?.("custom");
        }}
        onBack={showIconGrid}
        onInput={(event) => setCustomValue(event.currentTarget.value)}
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
