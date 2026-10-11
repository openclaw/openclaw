// Importing the module keeps this file a module, so the block below augments it.
import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import "@solidjs/web";
import "../components/tooltip.ts";
export type { JSX } from "@solidjs/web";

type Tooltip = HTMLElementTagNameMap["openclaw-tooltip"];

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-tooltip": HTMLAttributes<Tooltip> & {
        "prop:content"?: Tooltip["content"];
        "prop:contentTemplate"?: Tooltip["contentTemplate"];
        "prop:describe"?: Tooltip["describe"];
        "prop:disabled"?: Tooltip["disabled"];
        "prop:anchor"?: Tooltip["anchor"];
        "prop:placement"?: Tooltip["placement"];
        content?: string;
        disabled?: boolean;
        "open-on-click"?: boolean;
      };
      "wa-dropdown": HTMLAttributes<WaDropdown> &
        Properties<WaDropdown> & {
          open?: boolean;
          placement?: WaDropdown["placement"];
          "onWa-show"?: EventHandlerUnion<WaDropdown, CustomEvent>;
          "onWa-after-show"?: EventHandlerUnion<WaDropdown, CustomEvent>;
          "onWa-hide"?: EventHandlerUnion<WaDropdown, CustomEvent>;
          "onWa-after-hide"?: EventHandlerUnion<WaDropdown, CustomEvent>;
          "onWa-select"?: EventHandlerUnion<WaDropdown, CustomEvent<{ item: WaDropdownItem }>>;
        };
      "wa-dropdown-item": HTMLAttributes<WaDropdownItem> &
        Properties<WaDropdownItem> & {
          value?: string;
          disabled?: boolean;
          checked?: boolean;
          type?: WaDropdownItem["type"];
          variant?: WaDropdownItem["variant"];
          href?: string;
          target?: WaDropdownItem["target"];
          rel?: string;
        };
    }
    interface SVGAttributes<T> {
      "xml:space"?: "default" | "preserve";
    }
  }
}
