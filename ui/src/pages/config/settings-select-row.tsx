import type { JSX } from "@solidjs/web";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import { SettingsRow } from "../../components/solid/settings-ui.tsx";

export function SettingsSelectRow<T extends string>(props: {
  title: string;
  value: T;
  setting?: "send-shortcut" | "catalog-open-target";
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: string) => void;
  description?: JSX.Element;
  disabled?: boolean;
  nested?: boolean;
}) {
  return (
    <SettingsRow
      title={props.title}
      description={props.description}
      nested={props.nested}
      control={
        <SettingsSelect
          data-settings-send-shortcut={props.setting === "send-shortcut" ? "" : undefined}
          data-settings-catalog-open-target={
            props.setting === "catalog-open-target" ? "" : undefined
          }
          aria-label={props.title}
          disabled={props.disabled ?? false}
          value={props.value}
          onChange={(event) => props.onChange(event.currentTarget.value)}
          options={props.options}
        />
      }
    />
  );
}
