import { html, nothing } from "lit";
import {
  normalizeSessionIconValue,
  SESSION_ICON_GLYPH_IDS,
  SESSION_ICON_SVG_DATA_URL_PREFIX,
} from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";
import { resolveSessionIconGraphic } from "./session-icon-glyph-registry.ts";
import { renderSessionColorOptions } from "./session-menu-options.ts";

const SESSION_ICON_EMOJI_CHOICES = [
  "🦞",
  "🚀",
  "🐛",
  "✅",
  "🔥",
  "📦",
  "🧪",
  "📝",
  "🔍",
  "⚡",
  "🎯",
] as const;

function sessionEmojiPickerShortcut(): string | null {
  const platform = globalThis.navigator?.platform ?? "";
  if (/Mac|iPhone|iPad|iPod/u.test(platform)) {
    return "⌃⌘Space";
  }
  return /Win/u.test(platform) ? "Win+." : null;
}

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
  onGridKeydown: (event: KeyboardEvent) => void;
};

function renderCustomSessionIconEntry(props: AppearancePickerProps) {
  const normalized = normalizeSessionIconValue(props.customIconValue);
  const accepted =
    normalized && (props.allowSvg || !normalized.startsWith(SESSION_ICON_SVG_DATA_URL_PREFIX));
  const shortcut = sessionEmojiPickerShortcut();
  return html`
    <div
      class="session-menu__icon-custom-entry"
      aria-hidden=${props.mode !== "custom" ? "true" : nothing}
      ?inert=${props.mode !== "custom"}
    >
      <div class="session-menu__icon-custom-header">
        <button
          type="button"
          class="session-menu__icon-back"
          aria-label=${t("common.back")}
          @click=${props.onBack}
        >
          ${icons.arrowLeft}
        </button>
        <span
          >${t(props.allowSvg ? "sessionsView.customIconTitle" : "sessionsView.customEmojiTitle")}</span
        >
      </div>
      <div class="session-menu__icon-custom-controls">
        <textarea
          class="session-menu__icon-custom-input"
          rows="1"
          autocomplete="off"
          aria-label=${t(props.allowSvg ? "sessionsView.customIconTitle" : "sessionsView.customEmojiTitle")}
          .value=${props.customIconValue}
          @input=${props.onInput}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (accepted && !props.disabled) {
              props.onApply(event);
            }
          }}
        ></textarea>
        <button
          type="button"
          class="session-menu__icon-set"
          ?disabled=${!accepted || props.disabled}
          @click=${props.onApply}
        >
          ${t("sessionsView.customEmojiSet")}
        </button>
      </div>
      <div class="session-menu__icon-custom-hint">
        ${
          shortcut
            ? t(props.allowSvg ? "sessionsView.customIconHint" : "sessionsView.customEmojiHint", {
                shortcut,
              })
            : t(
                props.allowSvg
                  ? "sessionsView.customIconHintNoShortcut"
                  : "sessionsView.customEmojiHintNoShortcut",
              )
        }
      </div>
    </div>
  `;
}

function renderSessionIconGrid(props: AppearancePickerProps) {
  const tabStop =
    props.clearable !== false && props.currentIcon === null
      ? null
      : ([...SESSION_ICON_EMOJI_CHOICES, ...SESSION_ICON_GLYPH_IDS].find(
          (icon) => icon === props.currentIcon,
        ) ?? SESSION_ICON_EMOJI_CHOICES[0]);
  const renderChoice = (icon: string, glyph = false) => html`
    <button
      type="button"
      class=${`session-menu__icon-choice${glyph ? " session-menu__icon-choice--glyph" : ""}`}
      aria-label=${glyph ? icon : nothing}
      aria-pressed=${String(props.currentIcon === icon)}
      tabindex=${icon === tabStop ? "0" : "-1"}
      ?disabled=${props.disabled}
      title=${props.disabledReason ?? nothing}
      @click=${(event: MouseEvent) => props.onSelect(event, icon)}
    >
      ${glyph ? resolveSessionIconGraphic(icon) : icon}
    </button>
  `;
  return html`
    <div class="session-menu__icon-picker session-menu__icon-panel" data-mode=${props.mode}>
      <div
        class="session-menu__icon-options"
        aria-hidden=${props.mode !== "grid" ? "true" : nothing}
        ?inert=${props.mode !== "grid"}
        role="group"
        aria-label=${t("sessionsView.setIconMenu")}
        @keydown=${props.onGridKeydown}
      >
        <div class="session-menu__icon-section-label">${t("sessionsView.iconEmojiSection")}</div>
        <div class="session-menu__icon-grid">
          ${SESSION_ICON_EMOJI_CHOICES.map((icon) => renderChoice(icon))}
          <button
            type="button"
            class="session-menu__icon-choice session-menu__icon-choice--custom"
            aria-label=${t(props.allowSvg ? "sessionsView.customIconCell" : "sessionsView.customEmojiCell")}
            aria-pressed="false"
            tabindex="-1"
            ?disabled=${props.disabled}
            title=${props.disabledReason ?? nothing}
            @click=${props.onShowCustom}
          >
            ${icons.moreHorizontal}
          </button>
        </div>
        <div class="session-menu__icon-section-label">${t("sessionsView.iconGlyphSection")}</div>
        <div class="session-menu__icon-grid">
          ${
            props.clearable !== false
              ? html`
                  <button
                    type="button"
                    class="session-menu__icon-choice session-menu__icon-choice--glyph"
                    aria-label=${t("sessionsView.noIcon")}
                    title=${props.disabledReason ?? t("sessionsView.noIcon")}
                    aria-pressed=${String(props.currentIcon === null)}
                    tabindex=${tabStop === null ? "0" : "-1"}
                    ?disabled=${props.disabled}
                    @click=${(event: MouseEvent) => props.onSelect(event, null)}
                  >
                    ${icons.circleX}
                  </button>
                `
              : nothing
          }
          ${SESSION_ICON_GLYPH_IDS.map((icon) => renderChoice(icon, true))}
        </div>
      </div>
      ${renderCustomSessionIconEntry(props)}
    </div>
  `;
}

export function renderAppearancePicker(props: AppearancePickerProps) {
  return html`<div slot=${props.inline ? nothing : "submenu"} class="session-menu__appearance">
    <div class="session-menu__icon-section-label">${t("sessionsView.setColorMenu")}</div>
    ${renderSessionColorOptions({
      color: props.currentColor,
      allowDefault: props.clearable !== false,
      disabled: props.colorDisabled,
      disabledReason: props.colorDisabledReason,
      onSelect: props.onSelectColor,
    })}
    ${renderSessionIconGrid(props)}
    ${
      props.clearable !== false
        ? html`<div class="session-menu__separator" role="separator"></div>
            <button
              type="button"
              class="session-menu__icon-remove"
              ?disabled=${props.disabled || props.colorDisabled}
              title=${props.disabledReason ?? props.colorDisabledReason ?? nothing}
              @click=${props.onReset}
            >
              ${t("sessionsView.resetAppearance")}
            </button>`
        : nothing
    }
  </div>`;
}

export function handleAppearanceGridKeydown(event: KeyboardEvent) {
  const choice = event.target;
  if (!(choice instanceof HTMLButtonElement)) {
    return;
  }
  const offsets: Partial<Record<string, number>> = {
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -1,
    ArrowDown: 1,
  };
  const offset = offsets[event.key];
  if (offset === undefined) {
    return;
  }
  const grid = event.currentTarget;
  if (!(grid instanceof HTMLElement)) {
    return;
  }
  const choices = Array.from(
    grid.querySelectorAll<HTMLButtonElement>(".session-menu__icon-choice:not(:disabled)"),
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
    rows.sort((left, right) => left.top - right.top);
    const rowIndex = rows.findIndex((row) => row.choices.some((item) => item.button === choice));
    const targetRow = rows[(rowIndex + offset + rows.length) % rows.length];
    if (!targetRow) {
      return;
    }
    const rect = choice.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    // Appearance surfaces use different column counts; follow the visible row,
    // including across sections and when the last row is incomplete.
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
