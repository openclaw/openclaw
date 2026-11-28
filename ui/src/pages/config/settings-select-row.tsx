import type { JSX } from "@solidjs/web";
import { Picker, type PickerOption } from "../../components/select-picker.ts";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import { SettingsRow } from "../../components/solid/settings-ui.tsx";

export function SettingsSelectRow<T extends string>(props: {
  title: string;
  value: T;
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

/** The Control UI picker as a settings row, for choices that carry a status line or groups. */
export function SettingsPickerRow(props: {
  title: string;
  value: string;
  options: ReadonlyArray<PickerOption & { group?: string }>;
  onChange: (value: string) => void;
  description?: JSX.Element;
  disabled?: boolean;
}) {
  return (
    <SettingsRow
      title={props.title}
      description={props.description}
      control={
        <Picker
          params={{
            label: props.title,
            value: props.value,
            options: props.options,
            disabled: props.disabled,
            groupBy: (option) =>
              option.group ? { id: option.group, label: option.group } : undefined,
            onChange: props.onChange,
          }}
        />
      }
    />
  );
}
