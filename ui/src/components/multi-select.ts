import type { JSX as SolidJSX } from "@solidjs/web";
import { createComponent } from "solid-js";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import type { MultiSelectProps } from "./multi-select-types.ts";
import { MultiSelectView } from "./multi-select-view.tsx";

export type { MultiSelectOption, MultiSelectProps } from "./multi-select-types.ts";

export type MultiSelect = SolidBridgeElement<MultiSelectProps>;

export const MultiSelect = defineSolidBridge<MultiSelectProps>(
  "openclaw-multi-select",
  (props) => createComponent(MultiSelectView, props),
  {
    properties: {
      options: { default: [], attribute: false },
      value: { default: [], attribute: false },
      isExcluded: { default: () => false, attribute: false },
      getValueKey: { default: (value) => value, attribute: false },
      placeholder: { default: "", attribute: false },
      accessibleLabel: { default: "", attribute: false },
      allowCustom: { default: false, attribute: false },
      disabled: { default: false, attribute: false },
      onChange: { default: () => {}, attribute: false },
      onOpen: { default: () => {}, attribute: false },
    },
  },
);

type MultiSelectAttributes = SolidJSX.HTMLAttributes<MultiSelect> & {
  [Key in keyof MultiSelect as `prop:${Key & string}`]?: MultiSelect[Key];
};

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-multi-select": MultiSelectAttributes;
    }
  }
}
