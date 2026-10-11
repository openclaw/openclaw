import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import {
  formatKeyboardShortcutParts,
  isApplePlatform,
  type KeyboardShortcutCombo,
} from "../../lib/keyboard-shortcut-contract.ts";
import { hasKeyboardIcon, KeyboardIcon } from "./icon.tsx";

export type KbdOptions = {
  class?: string;
  inline?: boolean;
  slot?: string;
  ariaHidden?: boolean;
  hidden?: boolean;
  ref?: (element: HTMLElement) => void;
};

function Key(props: { value: string }) {
  const symbol = () => {
    const value = props.value === "↵" ? "⏎" : props.value;
    return hasKeyboardIcon(value) ? value : undefined;
  };
  return (
    <Show when={symbol()} fallback={<span class="kbd__text">{props.value}</span>}>
      {(key) => (
        <span
          class="kbd__symbol"
          style={{ position: "relative", display: "inline-block", width: "1em", height: "1em" }}
        >
          <span
            style={{
              position: "absolute",
              width: "1px",
              height: "1px",
              overflow: "hidden",
              "clip-path": "inset(50%)",
              "white-space": "nowrap",
            }}
          >
            {props.value}
          </span>
          <span
            aria-hidden="true"
            style={{ position: "absolute", inset: 0, display: "flex", "align-items": "center" }}
          >
            <KeyboardIcon
              symbol={key()}
              style={{ width: "1em", height: "1em", "stroke-width": "2.3" }}
            />
          </span>
        </span>
      )}
    </Show>
  );
}

/** Literal key labels; chords use KeyboardShortcut rather than parsed display strings. */
export function Kbd(props: KbdOptions & { keys: string | number | readonly string[] }) {
  const parts = () =>
    typeof props.keys === "string" || typeof props.keys === "number"
      ? [String(props.keys)]
      : props.keys;
  return (
    <kbd
      class={["shortcut-kbd", props.class]}
      style={props.inline ? { font: "inherit" } : undefined}
      slot={props.slot}
      aria-hidden={props.ariaHidden ? "true" : undefined}
      hidden={props.hidden}
      ref={props.ref}
    >
      <For each={parts()}>{(key) => <Key value={key} />}</For>
    </kbd>
  );
}

export function KeyboardShortcut(
  props: KbdOptions & {
    combo: KeyboardShortcutCombo;
    separateKeys?: boolean;
    applePlatform?: boolean;
  },
) {
  const apple = () => props.applePlatform ?? isApplePlatform();
  const parts = () => formatKeyboardShortcutParts(props.combo, apple());
  const keys = () =>
    apple() ? parts() : parts().flatMap((part, index) => (index === 0 ? [part] : ["+", part]));
  return (
    <>
      {props.separateKeys ? (
        <For each={parts()}>{(part) => <Kbd {...props} keys={part} />}</For>
      ) : (
        <Kbd {...props} keys={keys()} />
      )}
    </>
  );
}

export function ShortcutHint(props: { label: string; combo: KeyboardShortcutCombo }) {
  return (
    <>
      {props.label}
      {" ("}
      <KeyboardShortcut combo={props.combo} inline />
      {")"}
    </>
  );
}

/** Each placeholder gets its own nodes, preserving translated sentence order. */
export function ShortcutText(props: { text: string; shortcut: () => JSX.Element }) {
  return (
    <For each={props.text.split("{shortcut}")}>
      {(part, index) => (
        <>
          {index() > 0 && props.shortcut()}
          {part}
        </>
      )}
    </For>
  );
}
