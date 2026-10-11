import type { PickerOption, PickerParams } from "../select-picker.ts";
import "../select-picker.ts";

// The unported picker owns its menu and callback content inside this host.
export function Picker(params: PickerParams<PickerOption>) {
  return (
    <openclaw-select-picker
      class={[
        "settings-select picker-select",
        params.className,
        {
          "picker-select--submenu": params.variant === "submenu",
          "picker-select--sheet": params.sheet,
        },
      ]}
      style={{ width: "100%", "min-width": "min(138px,100%)" }}
      prop:params={{ ...params }}
    />
  );
}
