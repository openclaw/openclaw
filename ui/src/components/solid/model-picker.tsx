import { createMemo } from "solid-js";
import { modelPickerOptions, type ModelPickerParams } from "../model-picker-options.ts";
import { providerDisplayLabel } from "../provider-icon-data.ts";
import { Picker, type PickerParams } from "../select-picker.ts";
import { ProviderBrandIcon } from "./provider-icon.tsx";

export type { ModelPickerOption, ModelPickerParams } from "../model-picker-options.ts";

type ModelSelectOption = ReturnType<typeof modelPickerOptions>["options"][number];

export function ModelPicker(props: ModelPickerParams) {
  const choices = createMemo(() => modelPickerOptions(props));
  let customInput: HTMLInputElement;
  const commitCustom = (event: Event) => {
    if ((event.type === "change") === (props.custom?.commit === "change")) {
      // SAFETY: Both handlers are attached to the custom-model input below.
      props.onChange((event.currentTarget as HTMLInputElement).value);
    }
  };
  const providerIcon = (provider: string) => (
    <ProviderBrandIcon provider={provider} class="model-picker__provider-icon" />
  );
  const pickerParams = createMemo<PickerParams<ModelSelectOption>>(() => ({
    id: props.id,
    label: props.label,
    value: props.value,
    options: choices().options,
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
                get leading() {
                  return providerIcon(this.id);
                },
              }
            : undefined
      : undefined,
    showOptionTooltips: false,
    showSelectedDescription: props.showSelectedDetail,
    className: "model-picker__select ",
    onOpen: () => props.onOpen?.(),
    renderLeading: (option) => (option.provider ? providerIcon(option.provider) : undefined),
    onChange: (value) => props.onChange(value),
    onChangeTarget: (value) => {
      const input = props.custom ? customInput : undefined;
      if (input) {
        input.hidden = value !== choices().customValue;
        if (!input.hidden) {
          queueMicrotask(() => input.focus());
          return;
        }
      }
      props.onChange(value);
    },
  }));
  return (
    <div class="model-picker">
      <Picker params={pickerParams()} />
      {props.custom ? (
        <input
          ref={(input) => (customInput = input)}
          id={props.custom.id}
          class="settings-input model-picker__custom"
          aria-label={props.custom.label}
          aria-invalid={props.custom.invalid ? "true" : "false"}
          aria-describedby={props.custom.describedBy}
          placeholder={props.custom.placeholder ?? ""}
          value={props.value}
          hidden={choices().selectedIndex >= 0}
          disabled={props.disabled}
          onInput={commitCustom}
          onChange={commitCustom}
        />
      ) : undefined}
    </div>
  );
}
