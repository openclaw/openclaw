import type { JSX } from "@solidjs/web";
import { createEffect, onCleanup, onSettled } from "solid-js";
import {
  COMMAND_PALETTE_INPUT_ID,
  handlePaletteInputScroll,
  updatePaletteInputLayout,
  type CommandPaletteInputProps,
} from "./command-palette-input.ts";

export function CommandPaletteInput(
  props: Omit<CommandPaletteInputProps, "actions"> & { actions?: JSX.Element },
) {
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
    props.onInputRef(undefined);
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
