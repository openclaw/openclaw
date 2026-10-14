import { createMemo } from "solid-js";
import { renderChannelIcon } from "../channel-icon.ts";
import { Picker, type PickerOption, type PickerParams } from "../select-picker.ts";

export type ChannelPickerOption = PickerOption & {
  /** Neutral choices such as "last" or "all" are routing policy, not transports. */
  kind?: "channel" | "neutral";
};

export function ChannelPicker(props: PickerParams<ChannelPickerOption>) {
  const params = createMemo<PickerParams<ChannelPickerOption>>(() => ({
    ...props,
    className: "channel-picker",
    renderLeading: (option) =>
      option.kind === "neutral"
        ? undefined
        : renderChannelIcon(option.value, option.label, "picker"),
  }));
  return <Picker params={params()} />;
}
