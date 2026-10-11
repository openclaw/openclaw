// Importing the module keeps this file a module, so the block below augments it.
import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import type WaTabGroup from "@awesome.me/webawesome/dist/components/tab-group/tab-group.js";
import type WaTab from "@awesome.me/webawesome/dist/components/tab/tab.js";
import type { SparklineSample } from "../components/sparkline-tile.ts";
import "@solidjs/web";
export type { JSX } from "@solidjs/web";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "wa-tab-group": HTMLAttributes<WaTabGroup> &
        Properties<WaTabGroup> & {
          activation?: WaTabGroup["activation"];
          "without-scroll-controls"?: boolean;
          "onWa-tab-show"?: (event: CustomEvent<{ name: string }>) => void;
        };
      "wa-tab": HTMLAttributes<WaTab> & Properties<WaTab> & { panel?: string };
      "openclaw-sparkline": HTMLAttributes<HTMLElement> & {
        "prop:label": string;
        "prop:sub"?: string;
        "prop:samples": readonly SparklineSample[];
        "prop:format": (value: number) => string;
        "prop:floorMax"?: number;
        "prop:stackColors"?: readonly string[];
        "prop:autorange"?: boolean;
        autorange?: boolean;
      };
      "openclaw-tooltip": HTMLAttributes<HTMLElementTagNameMap["openclaw-tooltip"]> & {
        "prop:content"?: string;
        placement?: HTMLElementTagNameMap["openclaw-tooltip"]["placement"];
        "open-on-click"?: boolean;
        "auto-size"?: boolean;
      };
      "wa-dropdown": HTMLAttributes<WaDropdown> &
        Properties<WaDropdown> & {
          placement?: WaDropdown["placement"];
          "onWa-select"?: (event: CustomEvent<{ item: WaDropdownItem }>) => void;
          "onWa-after-hide"?: (event: CustomEvent<void>) => void;
        };
      "wa-dropdown-item": HTMLAttributes<WaDropdownItem> &
        Properties<WaDropdownItem> & { value?: WaDropdownItem["value"] };
    }
    interface SVGAttributes<T> {
      "xml:space"?: "default" | "preserve";
    }
  }
}
