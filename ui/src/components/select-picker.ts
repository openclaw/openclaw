import type { JSX } from "@solidjs/web";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { solidContent } from "../lit/solid-content.tsx";
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

// SAFETY: The bridge transports params unchanged; each caller supplies its own option subtype.
const TypedPicker = PickerBridge as <Option extends PickerOption>(props: {
  params: PickerParams<Option>;
  class?: string;
  style?: string;
}) => JSX.Element;

export function Picker<Option extends PickerOption>(props: {
  params: PickerParams<Option>;
  class?: string;
  style?: string;
}) {
  return TypedPicker({
    get params() {
      return props.params;
    },
    get class() {
      return props.class ?? pickerClass(props.params);
    },
    get style() {
      return props.style ?? "width:100%;min-width:min(138px,100%)";
    },
  });
}

export function pickerClass(params: { variant?: "submenu"; sheet?: boolean; className?: string }) {
  return `settings-select picker-select ${params.variant === "submenu" ? "picker-select--submenu" : ""} ${params.sheet ? "picker-select--sheet" : ""} ${params.className ?? ""}`;
}

export function renderPicker<Option extends PickerOption>(params: PickerParams<Option>) {
  return solidContent(Picker<Option>, { params });
}
