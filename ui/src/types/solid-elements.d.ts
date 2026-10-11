// Importing the module keeps this file a module, so the block below augments it.
import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import "@solidjs/web";
import type { OpenClawModalDialog } from "../components/modal-dialog.ts";
export type { JSX } from "@solidjs/web";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-modal-dialog": HTMLAttributes<OpenClawModalDialog> & {
        label?: string;
        "prop:label"?: string;
        "prop:description"?: string;
        "onModal-cancel"?: (event: Event) => void;
      };
      "openclaw-tooltip": HTMLAttributes<HTMLElement> & {
        "prop:content"?: string;
        "open-on-click"?: boolean;
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
