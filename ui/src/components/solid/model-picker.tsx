import { createMemo } from "solid-js";
import { providerDisplayLabel, renderProviderBrandIcon } from "../provider-icon.ts";
import type { PickerParams } from "../select-picker.ts";
import "../select-picker.ts";

export type ModelPickerOption = {
  value: string;
  label: string;
  provider?: string;
  detail?: string;
  disabled?: boolean;
};

type ModelSelectOption = ModelPickerOption & { description?: string };

export type ModelPickerParams = {
  id?: string;
  label: string;
  value: string;
  options: readonly ModelPickerOption[];
  disabled?: boolean;
  title?: string;
  placement?: "top" | "bottom";
  showSelectedDetail?: boolean;
  groupByProvider?: boolean;
  searchPlaceholder?: string;
  custom?: {
    label: string;
    placeholder?: string;
    commit?: "input" | "change";
    id?: string;
    invalid?: boolean;
    describedBy?: string;
  };
  onOpen?: () => void;
  onChange: (value: string) => void;
};

export function ModelPicker(props: ModelPickerParams) {
  const customValue = createMemo(() => {
    let value = "__openclaw_custom_model__";
    const values = new Set([props.value, ...props.options.map((option) => option.value)]);
    while (values.has(value)) {
      value += "_";
    }
    return value;
  });
  const options = createMemo(() => {
    const entries: ModelSelectOption[] = [
      ...props.options.map((option) => ({ ...option, description: option.detail })),
      ...(props.custom ? [{ value: customValue(), label: props.custom.label }] : []),
    ];
    const selected = entries.findIndex((option) => option.value === props.value);
    if (selected > 0) {
      entries.unshift(...entries.splice(selected, 1));
    }
    return entries;
  });
  const selectedIndex = () => options().findIndex((option) => option.value === props.value);
  const commitCustom = (event: Event) => {
    if ((event.type === "change") === (props.custom?.commit === "change")) {
      // SAFETY: Both handlers are attached to the custom-model input below.
      props.onChange((event.currentTarget as HTMLInputElement).value);
    }
  };
  const providerIcon = (provider: string) =>
    renderProviderBrandIcon(provider, { className: "model-picker__provider-icon" });
  const pickerParams = createMemo<PickerParams<ModelSelectOption>>(() => ({
    id: props.id,
    label: props.label,
    value: props.value,
    options: options(),
    disabled: props.disabled,
    title: props.title,
    placement: props.placement,
    searchable: true,
    searchPlaceholder: props.searchPlaceholder,
    groupBy: props.groupByProvider
      ? (option) =>
          option.provider
            ? {
                id: option.provider,
                label: providerDisplayLabel(option.provider),
                leading: providerIcon(option.provider),
              }
            : undefined
      : undefined,
    showOptionTooltips: false,
    showSelectedDescription: props.showSelectedDetail,
    className: "model-picker__select ",
    onOpen: () => props.onOpen?.(),
    renderLeading: (option) => (option.provider ? providerIcon(option.provider) : undefined),
    onChange: (value) => props.onChange(value),
    onChangeTarget: (value, select) => {
      const input = select
        .closest(".model-picker")
        ?.querySelector<HTMLInputElement>(".model-picker__custom");
      if (value === customValue() && input) {
        input.hidden = false;
        queueMicrotask(() => input.focus());
        return;
      }
      if (input) {
        input.hidden = true;
      }
      props.onChange(value);
    },
  }));
  return (
    <div class="model-picker">
      <openclaw-select-picker
        class="settings-select picker-select model-picker__select "
        style={{ width: "100%", "min-width": "min(138px,100%)" }}
        prop:params={pickerParams()}
      />
      {props.custom ? (
        <input
          id={props.custom.id}
          class="settings-input model-picker__custom"
          aria-label={props.custom.label}
          aria-invalid={props.custom.invalid ? "true" : "false"}
          aria-describedby={props.custom.describedBy}
          placeholder={props.custom.placeholder ?? ""}
          value={props.value}
          hidden={selectedIndex() >= 0}
          disabled={props.disabled}
          onInput={commitCustom}
          onChange={commitCustom}
        />
      ) : undefined}
    </div>
  );
}
