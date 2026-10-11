import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import type WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";
import type WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import type WaSwitch from "@awesome.me/webawesome/dist/components/switch/switch.js";
import type { JSX } from "@solidjs/web";
import type { MascotMood } from "../components/mascot-pose.ts";
export type { JSX } from "@solidjs/web";

// Keep ambient tag contracts independent of renderer modules: SDK declarations include this file.
type LegacyAttributes<T extends HTMLElement> = JSX.HTMLAttributes<T> & JSX.Properties<T>;
type Tooltip = HTMLElementTagNameMap["openclaw-tooltip"];

declare module "@solidjs/web" {
  namespace JSX {
    interface EventHandlersElement<T> {
      "onWa-show"?: EventHandlerUnion<T, CustomEvent>;
      "onWa-after-show"?: EventHandlerUnion<T, CustomEvent>;
      "onOpenclaw-composer-dismiss-invocations"?: EventHandlerUnion<T, CustomEvent>;
    }
    interface IntrinsicElements {
      "wa-popup": LegacyAttributes<WaPopup> & {
        active?: boolean;
        placement?: WaPopup["placement"];
        strategy?: WaPopup["strategy"];
        "onWa-reposition"?: EventHandlerUnion<WaPopup, CustomEvent>;
      };
      "wa-switch": LegacyAttributes<WaSwitch> & {
        size?: WaSwitch["size"];
        checked?: boolean;
        disabled?: boolean;
      };
      "openclaw-tooltip": HTMLAttributes<Tooltip> & {
        "prop:content"?: Tooltip["content"];
        "prop:contentTemplate"?: Tooltip["contentTemplate"];
        "prop:describe"?: Tooltip["describe"];
        "prop:disabled"?: Tooltip["disabled"];
        "prop:anchor"?: Tooltip["anchor"];
        "prop:placement"?: Tooltip["placement"];
        content?: string;
        disabled?: boolean;
        placement?: Tooltip["placement"];
        "open-on-click"?: boolean;
        "auto-size"?: boolean;
      };
      "openclaw-agent-row-chip": HTMLAttributes<HTMLElement> & {
        "prop:agentId"?: string;
      };
      "openclaw-mascot": LegacyAttributes<HTMLElement> & {
        mood?: MascotMood;
        "prop:size"?: number;
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
        Properties<WaDropdownItem> &
        Partial<
          Pick<
            WaDropdownItem,
            "value" | "type" | "variant" | "disabled" | "checked" | "href" | "target" | "rel"
          >
        >;
      "wa-popover": LegacyAttributes<WaPopover> &
        Partial<Pick<WaPopover, "for" | "placement">> & {
          distance?: number | `${number}`;
          "without-arrow"?: boolean;
          "onWa-show"?: (event: Event) => void;
          "onWa-after-show"?: (event: Event) => void;
          "onWa-hide"?: (event: Event) => void;
          "onWa-after-hide"?: (event: Event) => void;
        };
    }
    interface SVGAttributes<T> {
      "xml:space"?: "default" | "preserve";
    }
  }
}
