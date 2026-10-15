import type { JSX } from "@solidjs/web";
import { createEffect, onCleanup, onSettled } from "solid-js";

export const COMMAND_PALETTE_INPUT_ID = "cmd-palette-input";

type CommandPaletteInputProps = {
  value: string;
  placeholder: string;
  onInputRef: (element: Element | undefined, previous?: HTMLTextAreaElement) => void;
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

function updatePaletteInputOverflow(textarea: HTMLTextAreaElement) {
  const root = textarea.closest(".cmd-palette__entry");
  const overflow = textarea.scrollHeight - textarea.clientHeight;
  root?.toggleAttribute("data-scroll-fade-top", overflow > 1 && textarea.scrollTop > 1);
  root?.toggleAttribute(
    "data-scroll-fade-bottom",
    overflow > 1 && textarea.scrollTop < overflow - 1,
  );
}

// Cold and loaded palettes share geometry without pulling in the session draft.
function updatePaletteInputLayout(textarea: HTMLTextAreaElement, editing = false) {
  const root = textarea.closest<HTMLElement>(".cmd-palette__entry");
  const actions = root?.querySelector<HTMLElement>(".cmd-palette__input-actions");
  if (root && actions) {
    root.style.setProperty(
      "--cmd-palette-actions-width",
      `${actions.getBoundingClientRect().width}px`,
    );
  }
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
  updatePaletteInputOverflow(textarea);
}

function handlePaletteInputScroll(event: Event) {
  const textarea = event.currentTarget;
  if (textarea instanceof HTMLTextAreaElement && textarea.isConnected) {
    updatePaletteInputOverflow(textarea);
  }
}

export function CommandPaletteInput(props: CommandPaletteInputProps) {
  let textarea!: HTMLTextAreaElement;
  let observer: ResizeObserver | undefined;
  let frame: number | undefined;
  let measuredValue: string | undefined;
  let measuredPlaceholder: string | undefined;
  const scheduleLayout = () => {
    if (frame !== undefined) {
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (!textarea.isConnected) {
        return;
      }
      updatePaletteInputLayout(textarea);
      measuredValue = textarea.value;
      measuredPlaceholder = textarea.placeholder;
    });
  };
  createEffect(
    () => ({ value: props.value, placeholder: props.placeholder }),
    ({ value, placeholder }) => {
      // Input events already measured the edit. Selection and search updates
      // leave the caret, scroll position, and existing geometry untouched.
      if (value !== measuredValue || placeholder !== measuredPlaceholder) {
        scheduleLayout();
      }
    },
  );
  onSettled(() => {
    props.onInputRef(textarea);
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(scheduleLayout);
      const entry = textarea.closest(".cmd-palette__entry")!;
      observer.observe(entry);
      observer.observe(entry.querySelector(".cmd-palette__input-actions")!);
    }
    scheduleLayout();
  });
  onCleanup(() => {
    // A replacement field can mount before the old interop root is disposed.
    props.onInputRef(undefined, textarea);
    observer?.disconnect();
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
    }
  });
  return (
    <div class="cmd-palette__entry">
      <div class="cmd-palette__input-scroll">
        <textarea
          ref={(element) => {
            textarea = element;
          }}
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
          placeholder={props.placeholder}
          value={props.value}
          disabled={props.disabled}
          readonly={props.readOnly}
          onScroll={handlePaletteInputScroll}
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
            updatePaletteInputLayout(event.currentTarget, true);
            measuredValue = event.currentTarget.value;
            measuredPlaceholder = event.currentTarget.placeholder;
          }}
        />
      </div>
      <div class="cmd-palette__input-actions">{props.actions}</div>
    </div>
  );
}
