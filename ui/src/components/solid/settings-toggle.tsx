import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { liveChecked } from "../../lib/reactive/live-checked.ts";
import { nextSettingsRadioName } from "./settings-control-id.ts";
import type { SettingsToggleControl } from "./settings-ui.types.ts";

export function ToggleControl(
  props: SettingsToggleControl & {
    inputLabel?: string;
    label?: JSX.Element;
    labelledBy?: string;
    inputRef?: (element: HTMLInputElement) => void;
  },
) {
  const labelId = nextSettingsRadioName();
  return (
    <span class="settings-toggle">
      <input
        ref={[liveChecked(() => props.checked), (element) => props.inputRef?.(element)]}
        class="settings-toggle__input"
        type="checkbox"
        role="switch"
        disabled={props.disabled}
        aria-disabled={props.saving ? "true" : undefined}
        aria-label={props.inputLabel}
        aria-labelledby={props.inputLabel === undefined ? (props.labelledBy ?? labelId) : undefined}
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
          if (
            input.matches(":disabled") ||
            props.disabled ||
            props.saving ||
            props.onChange(input.checked) === false
          ) {
            input.checked = props.checked;
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
            return;
          }
          const input = event.currentTarget;
          if (input.matches(":disabled") || props.disabled || props.saving) {
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
      <Show when={props.inputLabel === undefined && !props.labelledBy}>
        <span id={labelId} class="settings-control__sr-label">
          {props.label}
        </span>
      </Show>
    </span>
  );
}

export function SettingsToggle(
  props: SettingsToggleControl & {
    ariaLabel: string;
    inputRef?: (element: HTMLInputElement) => void;
  },
) {
  return <ToggleControl {...props} inputLabel={props.ariaLabel} />;
}
