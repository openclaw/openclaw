import { html, nothing } from "lit";
import { modelPickerOptions, type ModelPickerParams } from "./model-picker-options.ts";
import { providerDisplayLabel, renderProviderBrandIcon } from "./provider-icon.ts";
import { renderPicker } from "./select-picker.ts";

export type { ModelPickerOption } from "./model-picker-options.ts";

export function renderModelPicker(params: ModelPickerParams) {
  const { customValue, options, selectedIndex } = modelPickerOptions(params);
  const commitCustom = (event: Event) => {
    if ((event.type === "change") === (params.custom?.commit === "change")) {
      params.onChange((event.currentTarget as HTMLInputElement).value);
    }
  };
  const providerIcon = (provider: string) =>
    renderProviderBrandIcon(provider, { className: "model-picker__provider-icon" });
  return html`
    <div class="model-picker">
      ${renderPicker({
        id: params.id,
        label: params.label,
        value: params.value,
        options,
        disabled: params.disabled,
        title: params.title,
        placement: params.placement,
        searchable: true,
        searchPlaceholder: params.searchPlaceholder,
        groupBy: params.groupByProvider
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
        showSelectedDescription: params.showSelectedDetail,
        className: "model-picker__select ",
        onOpen: params.onOpen,
        renderLeading: (option) => (option.provider ? providerIcon(option.provider) : nothing),
        onChange: params.onChange,
        onChangeTarget: (value, select) => {
          const wrapper = select.closest(".model-picker");
          const input = wrapper?.querySelector<HTMLInputElement>(".model-picker__custom");
          if (value === customValue && input) {
            input.hidden = false;
            queueMicrotask(() => input.focus());
            return;
          }
          if (input) {
            input.hidden = true;
          }
          params.onChange(value);
        },
      })}
      ${
        params.custom
          ? html`<input
              id=${params.custom.id ?? nothing}
              class="settings-input model-picker__custom"
              aria-label=${params.custom.label}
              aria-invalid=${params.custom.invalid ? "true" : "false"}
              aria-describedby=${params.custom.describedBy ?? nothing}
              placeholder=${params.custom.placeholder ?? ""}
              .value=${params.value}
              ?hidden=${selectedIndex >= 0}
              ?disabled=${params.disabled}
              @input=${commitCustom}
              @change=${commitCustom}
            />`
          : nothing
      }
    </div>
  `;
}
