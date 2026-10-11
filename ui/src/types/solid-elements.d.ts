import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import type WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";
import type { JSX } from "@solidjs/web";
import type { MascotMood } from "../components/mascot-pose.ts";
export type { JSX } from "@solidjs/web";

// Keep ambient tag contracts independent of renderer modules: SDK declarations include this file.
type LegacyAttributes<T extends HTMLElement> = JSX.HTMLAttributes<T> & JSX.Properties<T>;

type ElementProperties<T> = { [Key in keyof T as `prop:${string & Key}`]?: T[Key] };

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-tooltip": HTMLAttributes<HTMLElementTagNameMap["openclaw-tooltip"]> & {
        "prop:content"?: string;
        "prop:describe"?: boolean;
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
      "openclaw-agent-row-chip": HTMLAttributes<HTMLElement> & {
        "prop:agentId"?: string;
      };
      "openclaw-mascot": LegacyAttributes<HTMLElement> & {
        mood?: MascotMood;
        "prop:size"?: number;
      };
      "wa-dropdown": HTMLAttributes<WaDropdown> &
        Properties<WaDropdown> & {
          placement?: WaDropdown["placement"];
          "onWa-show"?: (event: Event) => void;
          "onWa-hide"?: (event: Event) => void;
          "onWa-select"?: (event: CustomEvent<{ item: WaDropdownItem }>) => void;
          "onWa-after-hide"?: (event: CustomEvent<void>) => void;
        };
      "wa-dropdown-item": HTMLAttributes<WaDropdownItem> &
        Properties<WaDropdownItem> &
        Partial<Pick<WaDropdownItem, "value" | "type" | "variant" | "disabled">> & {
          "onSubmenu-opening"?: (event: CustomEvent<{ item: HTMLElement }>) => void;
        };
      "wa-popover": LegacyAttributes<WaPopover> &
        Partial<Pick<WaPopover, "for" | "placement">> & {
          "without-arrow"?: boolean;
          "onWa-show"?: (event: Event) => void;
          "onWa-hide"?: (event: Event) => void;
        };
    }
    interface SVGAttributes<T> {
      "xml:space"?: "default" | "preserve";
    }
  }
}
