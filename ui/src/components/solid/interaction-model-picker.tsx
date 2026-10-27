import { createMemo } from "solid-js";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { ModelPicker, type ModelPickerOption } from "./model-picker.tsx";

registerEnglishCatalog(registerModelControlsEnglish);
const INHERIT = "__openclaw_inherit_interaction__";

export function InteractionModelPicker(props: {
  id: string;
  kind: "computer" | "browser";
  models: (ModelCatalogEntry & { selectionRef?: string })[];
  value?: string | null;
  inherit?: { model?: string | null };
  disabled: boolean;
  title?: string;
  onChange: (value: string | null) => void;
  onOpen?: () => void;
}) {
  const options = createMemo(() => {
    const choices: ModelPickerOption[] = [];
    if (props.inherit) {
      choices.push({
        value: INHERIT,
        label: t("chat.modelControls.interactionInherit", {
          model: props.inherit.model || t("chat.modelControls.interactionUseChatModel"),
        }),
      });
    }
    choices.push({ value: "", label: t("chat.modelControls.interactionUseChatModel") });
    for (const model of props.models) {
      const vision = model.input?.includes("image") === true;
      choices.push({
        value: model.selectionRef ?? model.provider + "/" + model.id,
        label: model.name || model.id,
        provider: model.provider,
        disabled:
          !vision ||
          model.supportsTools === false ||
          model.available === false ||
          model.manualSelectionAllowed === false,
        ...(!vision || model.supportsTools === false
          ? { description: t("chat.modelControls.interactionVisionRequired") }
          : {}),
      });
    }
    const selected = props.value;
    if (selected && !choices.some((option) => option.value === selected)) {
      choices.push({ value: selected, label: selected, disabled: true });
    }
    return choices;
  });
  return (
    <ModelPicker
      windowed
      id={props.id}
      label={t(
        props.kind === "computer"
          ? "chat.modelControls.computerLabel"
          : "chat.modelControls.browserLabel",
      )}
      value={props.value ?? (props.inherit ? INHERIT : "")}
      options={options()}
      disabled={props.disabled}
      title={props.title}
      onChange={(value) => props.onChange(value === INHERIT ? null : value)}
      onOpen={() => props.onOpen?.()}
    />
  );
}
