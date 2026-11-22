import type { JSX } from "@solidjs/web";
import { For, omit } from "solid-js";

export function SettingsSelect(
  props: Omit<JSX.SelectHTMLAttributes<HTMLSelectElement>, "children" | "multiple" | "value"> & {
    value: string;
    options: readonly { value: string; label: JSX.Element; disabled?: boolean }[];
  },
) {
  const attributes = omit(props, "options", "class");
  return (
    <select {...attributes} class={["settings-select", props.class]}>
      <For each={props.options} keyed={(option) => option.value}>
        {(option) => (
          <option
            value={option().value}
            selected={props.value === option().value}
            disabled={option().disabled}
            // SAFETY: the typeof check reads the same accessor in the same synchronous expression.
            title={typeof option().label === "string" ? (option().label as string) : undefined}
          >
            {option().label}
          </option>
        )}
      </For>
    </select>
  );
}
