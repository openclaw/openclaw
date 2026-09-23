import type { ModelCatalogResult } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { registerModelControlsEnglish } from "../i18n/locales/en-model-controls.ts";
import { registerSettingsEnglish } from "../i18n/locales/en-settings.ts";
import { renderModelPicker, type ModelPickerOption } from "./model-picker.ts";

registerModelControlsEnglish();
registerSettingsEnglish();

export type DecisionModelEntry = NonNullable<ModelCatalogResult["decisionModels"]>[number];
export function decisionModelSetupLabel(model: DecisionModelEntry): string | undefined {
  if (!model.readiness) {
    return undefined;
  }
  const key =
    model.readiness === "configured"
      ? "configured"
      : model.readiness === "auth-rejected"
        ? "rejected"
        : model.setup?.kind === "api-key"
          ? "addKey"
          : model.setup?.kind === "local-server"
            ? "connectServer"
            : "setUpModel";
  return [model.setup?.label, t(`modelProviders.decisionSetup.${key}`)].filter(Boolean).join(" · ");
}
const INHERIT_VALUE = "__openclaw_inherit_decision__";

export function renderDecisionModelPicker(params: {
  id: string;
  models: readonly DecisionModelEntry[];
  value: string | null | undefined;
  inherit?: { model: string | undefined };
  disabled: boolean;
  title?: string;
  onOpen?: () => void;
  onChange: (model: string | null) => void;
}) {
  const options: ModelPickerOption[] = params.models.map((model) => ({
    value: `${model.provider}/${model.id}`,
    label: model.name,
    provider: model.provider,
    detail: decisionModelSetupLabel(model),
    status:
      model.readiness === "auth-rejected"
        ? "danger"
        : model.setup && model.readiness !== "configured"
          ? "warning"
          : undefined,
  }));
  options.sort((a, b) => a.label.localeCompare(b.label));
  const selected = params.value?.trim();
  if (selected && !options.some((option) => option.value === selected)) {
    options.push({
      value: selected,
      label: selected,
      detail: t("chat.modelControls.decisionUnavailable"),
      disabled: true,
    });
  }
  const inherited = params.inherit?.model?.trim();
  const inheritedName = options.find((option) => option.value === inherited)?.label ?? inherited;
  return renderModelPicker({
    id: params.id,
    label: t("chat.modelControls.decisionLabel"),
    value: params.inherit && params.value == null ? INHERIT_VALUE : (selected ?? ""),
    options: [
      ...(params.inherit
        ? [
            {
              value: INHERIT_VALUE,
              label: t("chat.modelControls.decisionInherit", {
                model: inheritedName || t("chat.modelControls.decisionDisabled"),
              }),
              ...(inherited &&
              !params.models.some((model) => `${model.provider}/${model.id}` === inherited)
                ? { detail: t("chat.modelControls.decisionUnavailable") }
                : {}),
            },
          ]
        : []),
      { value: "", label: t("chat.modelControls.decisionDisabled") },
      ...options,
    ],
    disabled: params.disabled,
    title: params.title,
    showSelectedDetail: true,
    groupByProvider: true,
    searchPlaceholder: t("chat.modelControls.searchModels"),
    onOpen: params.onOpen,
    onChange: (value) =>
      params.onChange(value === INHERIT_VALUE || (!params.inherit && value === "") ? null : value),
  });
}
