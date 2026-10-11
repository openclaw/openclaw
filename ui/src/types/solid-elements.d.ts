// Importing the module keeps this file a module, so the block below augments it.
import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import type WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";
import "@solidjs/web";
export type { JSX } from "@solidjs/web";

type ElementProperties<T> = { [Key in keyof T as `prop:${string & Key}`]?: T[Key] };

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-tooltip": HTMLAttributes<HTMLElementTagNameMap["openclaw-tooltip"]> & {
        "prop:content"?: string;
        placement?: HTMLElementTagNameMap["openclaw-tooltip"]["placement"];
        "open-on-click"?: boolean;
        "auto-size"?: boolean;
      };
      "openclaw-elapsed-time": HTMLAttributes<HTMLElementTagNameMap["openclaw-elapsed-time"]> &
        Properties<HTMLElementTagNameMap["openclaw-elapsed-time"]>;
      "openclaw-viewer-facepile": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-viewer-facepile"]
      > &
        ElementProperties<
          Pick<
            HTMLElementTagNameMap["openclaw-viewer-facepile"],
            "staticParticipants" | "totalCount" | "maxVisible" | "personActivity"
          >
        >;
      "wa-popover": HTMLAttributes<WaPopover> &
        Properties<WaPopover> & {
          for?: string;
          placement?: WaPopover["placement"];
          "without-arrow"?: boolean;
          "onWa-show"?: (event: Event) => void;
          "onWa-hide"?: (event: Event) => void;
        };
      "wa-dropdown": HTMLAttributes<WaDropdown> &
        Properties<WaDropdown> & {
          placement?: WaDropdown["placement"];
          "onWa-show"?: (event: Event) => void;
          "onWa-hide"?: (event: Event) => void;
          "onWa-after-hide"?: (event: CustomEvent<void>) => void;
          "onWa-select"?: (event: CustomEvent<{ item: WaDropdownItem }>) => void;
        };
      "wa-dropdown-item": HTMLAttributes<WaDropdownItem> &
        Properties<WaDropdownItem> & {
          value?: WaDropdownItem["value"];
          variant?: WaDropdownItem["variant"];
          type?: WaDropdownItem["type"];
          "onSubmenu-opening"?: (event: CustomEvent<{ item: HTMLElement }>) => void;
        };
    }
    interface SVGAttributes<T> {
      "xml:space"?: "default" | "preserve";
    }
  }
}
