import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import { SettingsRow } from "../../components/solid/settings-ui.tsx";

type SettingsSelectRowProps<T extends string> = {
  title: string;
  value: T;
  setting?: "send-shortcut" | "catalog-open-target";
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: string) => void;
  description?: JSX.Element;
  disabled?: boolean;
};

export function SettingsSelectRow<T extends string>(props: SettingsSelectRowProps<T>) {
  return (
    <SettingsRow
      title={props.title}
      description={props.description}
      control={
        <select
          class="settings-select"
          data-settings-send-shortcut={props.setting === "send-shortcut" ? "" : undefined}
          data-settings-catalog-open-target={
            props.setting === "catalog-open-target" ? "" : undefined
          }
          aria-label={props.title}
          disabled={props.disabled ?? false}
          value={props.value}
          onChange={(event) => props.onChange(event.currentTarget.value)}
        >
          <For each={props.options} keyed={(option) => option.value}>
            {(option) => (
              <option value={option().value} selected={props.value === option().value}>
                {option().label}
              </option>
            )}
          </For>
        </select>
      }
    />
  );
}
