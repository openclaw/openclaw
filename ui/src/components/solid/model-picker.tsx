import { createMemo, For, Show } from "solid-js";
import { modelPickerOptions, type ModelPickerParams } from "../model-picker-options.ts";
import { providerDisplayLabel } from "../provider-icon-data.ts";
import { Picker, type PickerParams } from "../select-picker.ts";
import { ProviderBrandIcon } from "./provider-icon.tsx";

export type { ModelPickerOption, ModelPickerParams } from "../model-picker-options.ts";

type ModelSelectOption = ReturnType<typeof modelPickerOptions>["options"][number];

export function ModelPicker(props: ModelPickerParams & { windowed?: boolean }) {
  const options = createMemo(() => props.options);
  const selectedValue = createMemo(() => props.value);
  const customLabel = createMemo(() => props.custom?.label);
  const choices = createMemo(() => {
    const label = customLabel();
    return modelPickerOptions({
      options: options(),
      value: selectedValue(),
      custom: label === undefined ? undefined : { label },
    });
  });
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
  const renderWindowSizer = (visible: readonly ModelSelectOption[]) => {
    const groups = new Map<
      string,
      {
        key: string;
        provider?: string;
        description?: string;
        labels: string[];
      }
    >();
    for (const option of visible) {
      // Every provider icon has the same 20px track. Equal detail text therefore
      // lets one multiline label reproduce a group's widest intrinsic row.
      const key = `${Boolean(option.provider)}:${option.description ?? ""}`;
      let group = groups.get(key);
      if (!group) {
        // Unusual catalogs with many distinct details keep their original sizing
        // and rendering instead of growing a second large set of row owners.
        if (groups.size === 32) {
          return undefined;
        }
        group = { key, provider: option.provider, description: option.description, labels: [] };
        groups.set(key, group);
      }
      // Labels normally collapse CSS whitespace; only our separators start lines.
      group.labels.push(option.label.replace(/[ \t\n\r\f]+/g, " ").replace(/^ | $/g, ""));
    }
    return (
      <div class="picker-select__sizer" aria-hidden="true" inert>
        <For each={[...groups.values()]} keyed={(group) => group.key}>
          {(group) => (
            <div class="picker-select__option">
              <Show when={group().provider}>
                {(provider) => (
                  <span class="picker-select__leading">{providerIcon(provider())}</span>
                )}
              </Show>
              <span class="picker-select__copy">
                <span class="picker-select__label" style={{ "white-space": "pre" }}>
                  {group().labels.join("\n")}
                </span>
                {group().description && (
                  <span class="picker-select__description">{group().description}</span>
                )}
              </span>
              <span class="picker-select__check" />
            </div>
          )}
        </For>
      </div>
    );
  };
  const pickerParams = createMemo<PickerParams<ModelSelectOption>>(() => ({
    id: props.id,
    label: props.label,
    value: props.value,
    options: choices().options,
    disabled: props.disabled,
    title: props.title,
    placement: props.placement,
    searchable: true,
    windowed: props.windowed ? renderWindowSizer : undefined,
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
