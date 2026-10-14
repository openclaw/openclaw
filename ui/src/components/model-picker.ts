import { solidContent } from "../lit/solid-content.tsx";
import type { ModelPickerParams } from "./model-picker-options.ts";
import { ModelPicker } from "./solid/model-picker.tsx";

export type { ModelPickerOption } from "./model-picker-options.ts";

export function renderModelPicker(params: ModelPickerParams) {
  return solidContent(ModelPicker, params);
}
