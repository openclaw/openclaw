import type { JSX } from "@solidjs/web";
import { For, omit } from "solid-js";

export function SettingsSelect(
  props: Omit<JSX.SelectHTMLAttributes<HTMLSelectElement>, "children" | "multiple" | "value"> & {
    value: string;
    options: readonly { value: string; label: JSX.Element; disabled?: boolean }[];
  },
) {
  const attributes = omit(props, "options");
  return (
    <select class="settings-select" {...attributes}>
      <For each={props.options} keyed={(option) => option.value}>
        {(option) => (
          <option
            value={option().value}
            selected={props.value === option().value}
            disabled={option().disabled}
          >
            {option().label}
          </option>
        )}
      </For>
    </select>
  );
}
