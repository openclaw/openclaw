import { t } from "../i18n/index.ts";
import { registerModelControlsEnglish } from "../i18n/locales/en-model-controls.ts";
import {
  decisionModelPickerParams,
  type DecisionModelPickerParams,
} from "./model-picker-options.ts";
import { renderModelPicker } from "./model-picker.ts";

export type { DecisionModelEntry } from "./model-picker-options.ts";

registerModelControlsEnglish();

export function renderDecisionModelPicker(params: DecisionModelPickerParams) {
  return renderModelPicker(decisionModelPickerParams(params, t));
}
