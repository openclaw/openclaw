import { createMemo } from "solid-js";
import { modelPickerOptions, type ModelPickerParams } from "../model-picker-options.ts";
import { providerDisplayLabel, renderProviderBrandIcon } from "../provider-icon.ts";
import type { PickerParams } from "../select-picker.ts";
import "../select-picker.ts";

export type { ModelPickerOption, ModelPickerParams } from "../model-picker-options.ts";

type ModelSelectOption = ReturnType<typeof modelPickerOptions>["options"][number];

export function ModelPicker(props: ModelPickerParams) {
  const choices = createMemo(() => modelPickerOptions(props));
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
      if (value === choices().customValue && input) {
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
          hidden={choices().selectedIndex >= 0}
          disabled={props.disabled}
          onInput={commitCustom}
          onChange={commitCustom}
        />
      ) : undefined}
    </div>
  );
}
