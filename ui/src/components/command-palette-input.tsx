import type { JSX } from "@solidjs/web";
import { createMemo, onCleanup, onSettled } from "solid-js";
import { createLayoutMeasurement } from "../lib/reactive/layout-measurement.ts";
import { liveValue as createLiveValue } from "../lib/reactive/live-value.ts";

export const COMMAND_PALETTE_INPUT_ID = "cmd-palette-input";

type CommandPaletteInputProps = {
  value: string;
  placeholder: string;
  onInputRef: (element: Element | undefined, previous?: HTMLTextAreaElement) => void;
  onAutofocusRef?: (element: HTMLTextAreaElement) => void;
  onValueChange: (value: string, event: InputEvent) => void;
  onBeforeInput?: (event: InputEvent) => void;
  onSelectionChange?: (event: Event) => void;
  onCompositionStart?: () => void;
  onCompositionEnd?: () => void;
  actions?: JSX.Element;
  onPaste?: (event: ClipboardEvent) => void;
  disabled?: boolean;
  readOnly?: boolean;
  controls?: string;
  activeDescendant?: string;
  describedBy?: string;
};

export function CommandPaletteInput(props: CommandPaletteInputProps) {
  let textarea!: HTMLTextAreaElement;
  let entry!: HTMLDivElement;
  let actions!: HTMLDivElement;
  let measuredValue: string | undefined;
  let measuredPlaceholder: string | undefined;
  // Browser composition and selection belong to the live field until its value changes.
  const committedValue = createMemo(() => props.value);
  const committedPlaceholder = createMemo(() => props.placeholder);
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
    entry.style.setProperty(
      "--cmd-palette-actions-width",
      `${actions.getBoundingClientRect().width}px`,
    );
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
    textarea.style.height = `${Math.max(lineHeight, Math.min(lineHeight * 3, textarea.scrollHeight))}px`;
    const overflowing = textarea.scrollHeight > textarea.clientHeight + 1;
    textarea.style.overflowY = overflowing ? "auto" : "hidden";
    textarea.scrollTop = overflowing ? (followCaret ? textarea.scrollHeight : previousScroll) : 0;
    updateOverflow();
  }

  createLayoutMeasurement(
    () => {
      const value = committedValue();
      const placeholder = committedPlaceholder();
      // Input events already measured the edit; result navigation needs no layout.
      return value !== measuredValue || placeholder !== measuredPlaceholder
        ? [value, placeholder]
        : undefined;
    },
    () => {
      // Intrinsic sizing writes before reading scrollHeight and must stay atomic.
      updateLayout();
      measuredValue = textarea.value;
      measuredPlaceholder = textarea.placeholder;
    },
    { targets: () => [entry, actions] },
  );
  onSettled(() => {
    props.onInputRef(textarea);
  });
  onCleanup(() => {
    // A replacement field can mount before the old interop root is disposed.
    props.onInputRef(undefined, textarea);
  });
  return (
    <div ref={(element) => (entry = element)} class="cmd-palette__entry">
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
          id={COMMAND_PALETTE_INPUT_ID}
          class="cmd-palette__input"
          aria-label={props.placeholder}
          aria-autocomplete={props.controls ? "list" : undefined}
          aria-haspopup={props.controls ? "listbox" : undefined}
          aria-controls={props.controls}
          aria-activedescendant={props.activeDescendant}
          aria-describedby={props.describedBy}
          placeholder={committedPlaceholder()}
          disabled={props.disabled}
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
      <div ref={(element) => (actions = element)} class="cmd-palette__input-actions">
        {props.actions}
      </div>
    </div>
  );
}
