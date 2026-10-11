import { createMemo } from "solid-js";
import type { ModelCatalogResult } from "../../api/types.ts";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { ModelPicker, type ModelPickerOption } from "./model-picker.tsx";

registerEnglishCatalog(registerModelControlsEnglish);

export type DecisionModelEntry = NonNullable<ModelCatalogResult["decisionModels"]>[number];
const INHERIT_VALUE = "__openclaw_inherit_decision__";

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

export function DecisionModelPicker(props: DecisionModelPickerParams) {
  const selected = () => props.value?.trim();
  const inherited = () => props.inherit?.model?.trim();
  const options = createMemo(() => {
    const entries: ModelPickerOption[] = props.models.map((model) => ({
      value: `${model.provider}/${model.id}`,
      label: model.name,
      provider: model.provider,
    }));
    entries.sort((a, b) => a.label.localeCompare(b.label));
    const selection = selected();
    if (selection && !entries.some((option) => option.value === selection)) {
      entries.push({
        value: selection,
        label: selection,
        detail: t("chat.modelControls.decisionUnavailable"),
        disabled: true,
      });
    }
    const inheritedModel = inherited();
    const inheritedName =
      entries.find((option) => option.value === inheritedModel)?.label ?? inheritedModel;
    return [
      ...(props.inherit
        ? [
            {
              value: INHERIT_VALUE,
              label: t("chat.modelControls.decisionInherit", {
                model: inheritedName || t("chat.modelControls.decisionDisabled"),
              }),
              ...(inheritedModel &&
              !props.models.some((model) => `${model.provider}/${model.id}` === inheritedModel)
                ? { detail: t("chat.modelControls.decisionUnavailable") }
                : {}),
            },
          ]
        : []),
      { value: "", label: t("chat.modelControls.decisionDisabled") },
      ...entries,
    ];
  });
  return (
    <ModelPicker
      id={props.id}
      label={t("chat.modelControls.decisionLabel")}
      value={props.inherit && props.value == null ? INHERIT_VALUE : (selected() ?? "")}
      options={options()}
      disabled={props.disabled}
      title={props.title}
      showSelectedDetail
      groupByProvider
      searchPlaceholder={t("chat.modelControls.searchModels")}
      onOpen={() => props.onOpen?.()}
      onChange={(value) =>
        props.onChange(value === INHERIT_VALUE || (!props.inherit && value === "") ? null : value)
      }
    />
  );
}
