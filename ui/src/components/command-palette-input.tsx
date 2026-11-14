import type { JSX } from "@solidjs/web";
import { createMemo, onSettled, Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { keyboardHintsVisible } from "../lib/reactive/keyboard-hints.ts";
import { createLayoutMeasurement } from "../lib/reactive/layout-measurement.ts";
import { liveValue as createLiveValue } from "../lib/reactive/live-value.ts";
import type { CommandPaletteMode } from "./command-palette-contract.ts";
import { Icon } from "./solid/icon.tsx";
import { Kbd } from "./solid/kbd.tsx";
import { Tabs } from "./solid/tabs.tsx";

const MODE_ICONS = { search: "search", compose: "pencil" } as const;

export function CommandPaletteHint(props: { shortcut: JSX.Element; label: string }) {
  return (
    <Show when={keyboardHintsVisible()}>
      <span class="cmd-palette__hint">
        {props.shortcut}
        <span>{props.label}</span>
      </span>
    </Show>
  );
}

/** The footer the panel sits on: the mode switch, then the keys for the current mode. */
export function CommandPaletteDock(props: {
  mode: CommandPaletteMode;
  disabled?: boolean;
  onChange: (mode: CommandPaletteMode) => void;
  /** Keys for the current mode, placed before the Tab switch. */
  children?: JSX.Element;
}) {
  const other = () => (props.mode === "search" ? "compose" : "search");
  return (
    <div class="cmd-palette__dock">
      <Tabs
        class="cmd-palette__mode-tabs"
        ariaLabel={t("palette.modeLabel")}
        active={props.mode}
        onSelect={(mode) => props.onChange(mode === "compose" ? "compose" : "search")}
        items={(["search", "compose"] as const).map((mode) => ({
          value: mode,
          id: `cmd-palette-tab-${mode}`,
          panelId: "cmd-palette-panel",
          className: "cmd-palette__mode",
          disabled: props.disabled,
          label: (
            <>
              <Icon name={MODE_ICONS[mode]} />
              <span>{t(`palette.modes.${mode}`)}</span>
            </>
          ),
        }))}
      />
      <div id="cmd-palette-keys" class="cmd-palette__keys">
        {props.children}
        <CommandPaletteHint
          shortcut={<Kbd keys="Tab" />}
          label={t(`palette.modeSwitch.${other()}`)}
        />
      </div>
    </div>
  );
}

export const COMMAND_PALETTE_INPUT_ID = "cmd-palette-input";

export function CommandPaletteInput(props: {
  value: string;
  placeholder: string;
  onInputRef: (element: Element | undefined, previous?: HTMLTextAreaElement) => void;
  onAutofocusRef?: (element: HTMLTextAreaElement) => void;
  onValueChange: (value: string, event: InputEvent) => void;
  onBeforeInput?: (event: InputEvent) => void;
  onSelectionChange?: (event: Event) => void;
  onCompositionStart?: () => void;
  onCompositionEnd?: () => void;
  /** Search stays compact; Compose grows like the composer before it scrolls. */
  maxLines?: number;
  onPaste?: (event: ClipboardEvent) => void;
  busy?: boolean;
  readOnly?: boolean;
  controls?: string;
  activeDescendant?: string;
  describedBy?: string;
}) {
  let textarea!: HTMLTextAreaElement;
  let entry!: HTMLDivElement;
  let widthReference!: HTMLDivElement;
  let measuredValue: string | undefined;
  let measuredPlaceholder: string | undefined;
  let measuredMaxLines: number | undefined;
  // Browser composition and selection belong to the live field until its value changes.
  const committedValue = createMemo(() => props.value);
  const committedPlaceholder = createMemo(() => props.placeholder);
  const maxLines = createMemo(() => props.maxLines ?? 3);
  // The compiler batches native attributes; result/ARIA updates must not rewrite the field.
  const bindValue = createLiveValue(committedValue);

  function updateOverflow() {
    const overflow = textarea.scrollHeight - textarea.clientHeight;
    entry.toggleAttribute("data-scroll-fade-top", overflow > 1 && textarea.scrollTop > 1);
    entry.toggleAttribute(
      "data-scroll-fade-bottom",
      overflow > 1 && textarea.scrollTop < overflow - 1,
    );
  }

  // Cold and loaded palettes share geometry without pulling in the session draft.
  function updateLayout(editing = false) {
    const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight);
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
      return;
    }
    const previousScroll = textarea.scrollTop;
    // Rerenders and resizes preserve manual scroll; only editing follows the caret.
    const followCaret =
      editing &&
      document.activeElement === textarea &&
      textarea.selectionStart === textarea.selectionEnd &&
      textarea.selectionEnd === textarea.value.length;
    textarea.style.overflowY = "hidden";
    textarea.style.height = "0px";
    textarea.style.height = `${Math.max(lineHeight, Math.min(lineHeight * maxLines(), textarea.scrollHeight))}px`;
    const overflowing = textarea.scrollHeight > textarea.clientHeight + 1;
    textarea.style.overflowY = overflowing ? "auto" : "hidden";
    textarea.scrollTop = overflowing ? (followCaret ? textarea.scrollHeight : previousScroll) : 0;
    updateOverflow();
  }

  createLayoutMeasurement(
    () => {
      const value = committedValue();
      const placeholder = committedPlaceholder();
      const lines = maxLines();
      // Input events already measured the edit; result navigation needs no layout.
      return value !== measuredValue ||
        placeholder !== measuredPlaceholder ||
        lines !== measuredMaxLines
        ? [value, placeholder, lines]
        : undefined;
    },
    () => {
      // Intrinsic sizing writes before reading scrollHeight and must stay atomic.
      updateLayout();
      measuredValue = textarea.value;
      measuredPlaceholder = textarea.placeholder;
      measuredMaxLines = maxLines();
    },
    // The entry height follows the textarea; observe only its available width.
    { targets: () => [widthReference], fonts: true },
  );
  onSettled(() => {
    props.onInputRef(textarea);
    return () => {
      // A replacement field can mount before the old interop root is disposed.
      props.onInputRef(undefined, textarea);
    };
  });
  return (
    <div ref={(element) => (entry = element)} class="cmd-palette__entry">
      <div ref={(element) => (widthReference = element)} aria-hidden="true" />
      <div class="cmd-palette__input-scroll">
        <textarea
          ref={[
            (element) => {
              textarea = element;
              bindValue(element);
            },
            props.onAutofocusRef,
          ]}
          autofocus
          rows={1}
          enterkeyhint="enter"
          id={COMMAND_PALETTE_INPUT_ID}
          class="cmd-palette__input"
          aria-label={props.placeholder}
          aria-autocomplete={props.controls ? "list" : undefined}
          aria-haspopup={props.controls ? "listbox" : undefined}
          aria-controls={props.controls}
          aria-activedescendant={props.activeDescendant}
          aria-describedby={props.describedBy}
          placeholder={committedPlaceholder()}
          aria-busy={props.busy ? "true" : undefined}
          readonly={props.readOnly}
          onScroll={() => textarea.isConnected && updateOverflow()}
          onPaste={(event) => props.onPaste?.(event)}
          onBeforeInput={(event) => props.onBeforeInput?.(event)}
          onSelect={(event) => props.onSelectionChange?.(event)}
          onPointerUp={(event) => props.onSelectionChange?.(event)}
          onKeyUp={(event) => {
            if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
              props.onSelectionChange?.(event);
            }
          }}
          onCompositionStart={() => props.onCompositionStart?.()}
          onCompositionEnd={() => props.onCompositionEnd?.()}
          onInput={(event) => {
            props.onValueChange(event.currentTarget.value, event);
            updateLayout(true);
            measuredValue = event.currentTarget.value;
            measuredPlaceholder = event.currentTarget.placeholder;
          }}
        />
      </div>
    </div>
  );
}
