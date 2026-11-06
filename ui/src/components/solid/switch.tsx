import type { JSX } from "@solidjs/web";
import { createUniqueId, Show } from "solid-js";
import { liveChecked } from "../../lib/reactive/live-checked.ts";
import type { SettingsToggleControl } from "./settings-ui.types.ts";

/** `sm` sits in menu and popover rows; `md` sits in settings rows and pages. */
export type SwitchSize = "sm" | "md";

export type SwitchProps = SettingsToggleControl & {
  size?: SwitchSize;
  ariaLabel?: string;
  /** Id of visible text that names the switch. */
  ariaLabelledBy?: string;
  /** Screen-reader-only name, rendered beside the input when neither label prop is set. */
  label?: JSX.Element;
  inputRef?: (element: HTMLInputElement) => void;
};

/** The one switch: a native checkbox with switch semantics over the shared track. */
export function Switch(props: SwitchProps) {
  const labelId = `switch-label-${createUniqueId()}`;
  const blocked = (input: HTMLInputElement) =>
    input.matches(":disabled") || Boolean(props.disabled) || Boolean(props.saving);
  return (
    <span class={["settings-toggle", `settings-toggle--${props.size ?? "md"}`]}>
      <input
        ref={[liveChecked(() => props.checked), (element) => props.inputRef?.(element)]}
        class="settings-toggle__input"
        type="checkbox"
        role="switch"
        disabled={props.disabled}
        aria-disabled={props.saving ? "true" : undefined}
        aria-label={props.ariaLabel}
        aria-labelledby={
          props.ariaLabel === undefined ? (props.ariaLabelledBy ?? labelId) : undefined
        }
        onClick={(event) => {
          const input = event.currentTarget;
          if (props.disabled || props.saving) {
            // Busy switches keep focus (aria-disabled), so cancel the native toggle here.
            event.preventDefault();
          } else if (!input.matches(":disabled") && input.checked !== props.checked) {
            props.onAct?.(input.checked);
          }
        }}
        onChange={(event) => {
          const input = event.currentTarget;
          if (blocked(input) || props.onChange(input.checked) === false) {
            input.checked = props.checked;
          }
        }}
        onKeyDown={(event) => {
          const input = event.currentTarget;
          if (event.key === "Enter") {
            // Space toggles natively; Enter follows the switch pattern too.
            event.preventDefault();
            if (!blocked(input)) {
              input.click();
            }
            return;
          }
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
            return;
          }
          if (blocked(input)) {
            return;
          }
          event.preventDefault();
          const checked =
            (event.key === "ArrowRight") !== (getComputedStyle(input).direction === "rtl");
          if (checked === input.checked) {
            return;
          }
          input.checked = checked;
          props.onAct?.(checked);
          if (props.onChange(checked) === false) {
            input.checked = props.checked;
          }
        }}
      />
      <span class="settings-toggle__control" aria-hidden="true" />
      <Show when={props.ariaLabel === undefined && !props.ariaLabelledBy}>
        <span id={labelId} class="settings-control__sr-label">
          {props.label}
        </span>
      </Show>
    </span>
  );
}

/**
 * The same track for rows that already own switch semantics (menu checkbox items,
 * row buttons with role="switch"). Purely visual; the row carries state and focus.
 */
export function SwitchIndicator(props: { checked: boolean; size?: SwitchSize }) {
  return (
    <span
      class={["settings-toggle", `settings-toggle--${props.size ?? "sm"}`]}
      data-checked={props.checked ? "true" : "false"}
      aria-hidden="true"
    >
      <span class="settings-toggle__control" />
    </span>
  );
}
