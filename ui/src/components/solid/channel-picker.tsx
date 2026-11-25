import { createMemo } from "solid-js";
import { Picker, type PickerOption, type PickerParams } from "../select-picker.ts";
import { ChannelIcon } from "./channel-icon.tsx";

export type ChannelPickerOption = PickerOption & {
  /** Neutral choices such as "last" or "all" are routing policy, not transports. */
  kind?: "channel" | "neutral";
};

export function ChannelPicker(props: PickerParams<ChannelPickerOption>) {
  const params = createMemo<PickerParams<ChannelPickerOption>>(() => ({
    ...props,
    className: "channel-picker",
    renderLeading: (option) =>
      option.kind === "neutral" ? undefined : (
        <ChannelIcon channelId={option.value} label={option.label} variant="picker" />
      ),
  }));
  return <Picker params={params()} />;
}
