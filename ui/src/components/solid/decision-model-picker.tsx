import { createMemo } from "solid-js";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import {
  decisionModelPickerParams,
  type DecisionModelPickerParams,
} from "../model-picker-options.ts";
import { ModelPicker } from "./model-picker.tsx";

export type { DecisionModelEntry, DecisionModelPickerParams } from "../model-picker-options.ts";

registerEnglishCatalog(registerModelControlsEnglish);

export function DecisionModelPicker(props: DecisionModelPickerParams) {
  const params = createMemo(() => decisionModelPickerParams(props, t));
  return <ModelPicker {...params()} />;
}
