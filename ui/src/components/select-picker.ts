import type { JSX } from "@solidjs/web";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import type { PickerOption, PickerParams } from "./select-picker-types.ts";
import { PickerContent } from "./select-picker-view.tsx";
import "../styles/select-picker.css";

export type { PickerGroup, PickerOption, PickerParams } from "./select-picker-types.ts";

export type SelectPicker<Option extends PickerOption = PickerOption> = SolidBridgeElement<{
  params: PickerParams<Option>;
}>;

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-select-picker": SelectPicker;
  }
}

const PickerBridge = defineSolidBridge<{ params: PickerParams<PickerOption> }>(
  "openclaw-select-picker",
  (props, host) =>
    PickerContent({
      get params() {
        return props.params;
      },
      host,
    }),
  {
    properties: {
      params: { default: { label: "", value: null, options: [], onChange() {} }, attribute: false },
    },
  },
);

export function Picker<Option extends PickerOption>(props: {
  params: PickerParams<Option>;
  class?: JSX.ClassValue;
  style?: string;
}): JSX.Element {
  // SAFETY: The bridge transports params unchanged; each caller supplies its own option subtype.
  return (PickerBridge as typeof Picker)({
    get params() {
      return props.params;
    },
    get class() {
      return (
        props.class ?? [
          "settings-select picker-select",
          {
            "picker-select--submenu": props.params.variant === "submenu",
            "picker-select--sheet": props.params.sheet,
          },
          props.params.className,
        ]
      );
    },
    get style() {
      return props.style ?? "width:100%;min-width:min(138px,100%)";
    },
  });
}
