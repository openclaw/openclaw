import { solidContent } from "../lit/solid-content.tsx";
import type { PickerParams } from "./select-picker-types.ts";
import { ChannelPicker, type ChannelPickerOption } from "./solid/channel-picker.tsx";

export type { ChannelPickerOption } from "./solid/channel-picker.tsx";

export function renderChannelPicker(params: PickerParams<ChannelPickerOption>) {
  return solidContent(ChannelPicker, params);
}
