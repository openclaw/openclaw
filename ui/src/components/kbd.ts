import { html, nothing, type TemplateResult } from "lit";
import { ref, type RefOrCallback } from "lit/directives/ref.js";
import {
  formatKeyboardShortcutParts,
  isApplePlatform,
  type KeyboardShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";
import { keyboardIconShapes, strokeIcon } from "./icons-tools.ts";

function isSymbolKey(key: string): key is keyof typeof keyboardIconShapes {
  return Object.hasOwn(keyboardIconShapes, key);
}

type KbdOptions = {
  className?: string;
  inline?: boolean;
  slot?: string;
  ariaHidden?: boolean;
  hidden?: boolean;
  ref?: RefOrCallback;
};

function renderKey(key: string) {
  const symbol = key === "↵" ? "⏎" : key;
  return isSymbolKey(symbol)
    ? html`<span
        class="kbd__symbol"
        style="position:relative;display:inline-block;width:1em;height:1em"
        ><span
          style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap"
          >${key}</span
        ><span aria-hidden="true" style="position:absolute;inset:0;display:flex;align-items:center"
          >${strokeIcon(keyboardIconShapes[symbol], "width:1em;height:1em;stroke-width:2.3")}</span
        ></span
      >`
    : html`<span class="kbd__text">${key}</span>`;
}

/** Render literal key labels; chords use renderKeyboardShortcut, never parsed display strings. */
export function renderKbd(keys: string | number | readonly string[], options: KbdOptions = {}) {
  const parts = typeof keys === "string" || typeof keys === "number" ? [String(keys)] : keys;
  return html`<kbd
    class=${`shortcut-kbd${options.className ? ` ${options.className}` : ""}`}
    style=${options.inline ? "font:inherit" : nothing}
    slot=${options.slot ?? nothing}
    aria-hidden=${options.ariaHidden ? "true" : nothing}
    ?hidden=${options.hidden}
    ${options.ref ? ref(options.ref) : nothing}
    >${parts.map(renderKey)}</kbd
  >`;
}

export function renderKeyboardShortcut(
  combo: KeyboardShortcutCombo,
  options: KbdOptions & { separateKeys?: boolean; applePlatform?: boolean } = {},
) {
  const apple = options.applePlatform ?? isApplePlatform();
  const parts = formatKeyboardShortcutParts(combo, apple);
  if (options.separateKeys) {
    return html`${parts.map((part) => renderKbd(part, options))}`;
  }
  return renderKbd(
    apple ? parts : parts.flatMap((part, index) => (index === 0 ? [part] : ["+", part])),
    options,
  );
}

/** Shared bare shortcut suffix for noninteractive tooltip content. */
export function renderShortcutHint(label: string, combo: KeyboardShortcutCombo) {
  return html`${label}${" ("}${renderKeyboardShortcut(combo, { inline: true })})`;
}

/** Keep translated sentence order while replacing only its explicit shortcut placeholder. */
export function renderShortcutText(text: string, shortcut: TemplateResult) {
  return html`${text
    .split("{shortcut}")
    .map((part, index) => (index === 0 ? part : html`${shortcut}${part}`))}`;
}
