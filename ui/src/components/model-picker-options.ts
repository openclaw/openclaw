import type { ModelCatalogResult } from "../api/types.ts";
import type { t } from "../i18n/index.ts";

export type ModelPickerOption = {
  value: string;
  label: string;
  provider?: string;
  detail?: string;
  disabled?: boolean;
};

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
  preserveOrder?: boolean;
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

export function modelPickerOptions(params: ModelPickerParams) {
  let customValue = "__openclaw_custom_model__";
  const values = new Set([params.value, ...params.options.map((option) => option.value)]);
  while (values.has(customValue)) {
    customValue += "_";
  }
  const options: Array<ModelPickerOption & { description?: string }> = [
    ...params.options.map((option) => ({ ...option, description: option.detail })),
    ...(params.custom ? [{ value: customValue, label: params.custom.label }] : []),
  ];
  const selectedIndex = options.findIndex((option) => option.value === params.value);
  if (selectedIndex > 0 && !params.preserveOrder) {
    options.unshift(...options.splice(selectedIndex, 1));
  }
  return { customValue, options, selectedIndex };
}

export type DecisionModelEntry = NonNullable<ModelCatalogResult["decisionModels"]>[number];

export type DecisionModelPickerParams = {
  id: string;
  models: readonly DecisionModelEntry[];
  value: string | null | undefined;
  inherit?: { model: string | undefined };
  disabled: boolean;
  title?: string;
  onOpen?: () => void;
  onChange: (model: string | null) => void;
};

const INHERIT_VALUE = "__openclaw_inherit_decision__";

export function decisionModelPickerParams(
  params: DecisionModelPickerParams,
  translate: typeof t,
): ModelPickerParams {
  const options: ModelPickerOption[] = params.models.map((model) => ({
    value: `${model.provider}/${model.id}`,
    label: model.name,
    provider: model.provider,
  }));
  options.sort((a, b) => a.label.localeCompare(b.label));
  const selected = params.value?.trim();
  if (selected && !options.some((option) => option.value === selected)) {
    options.push({
      value: selected,
      label: selected,
      detail: translate("chat.modelControls.decisionUnavailable"),
      disabled: true,
    });
  }
  const inherited = params.inherit?.model?.trim();
  const inheritedName = options.find((option) => option.value === inherited)?.label ?? inherited;
  return {
    id: params.id,
    label: translate("chat.modelControls.decisionLabel"),
    value: params.inherit && params.value == null ? INHERIT_VALUE : (selected ?? ""),
    options: [
      ...(params.inherit
        ? [
            {
              value: INHERIT_VALUE,
              label: translate("chat.modelControls.decisionInherit", {
                model: inheritedName || translate("chat.modelControls.decisionDisabled"),
              }),
              ...(inherited &&
              !params.models.some((model) => `${model.provider}/${model.id}` === inherited)
                ? { detail: translate("chat.modelControls.decisionUnavailable") }
                : {}),
            },
          ]
        : []),
      { value: "", label: translate("chat.modelControls.decisionDisabled") },
      ...options,
    ],
    disabled: params.disabled,
    title: params.title,
    showSelectedDetail: true,
    groupByProvider: true,
    searchPlaceholder: translate("chat.modelControls.searchModels"),
    onOpen: params.onOpen,
    onChange: (value) =>
      params.onChange(value === INHERIT_VALUE || (!params.inherit && value === "") ? null : value),
  };
}
