import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import type WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";
import type { JSX } from "@solidjs/web";
import type { UpdateRunRecord } from "../../../src/infra/update-run-record.ts";
import type { MascotMood } from "../components/mascot-pose.ts";
import type { SelectPicker } from "../components/select-picker.ts";
export type { JSX } from "@solidjs/web";

// Keep ambient tag contracts independent of renderer modules: SDK declarations include this file.
type LegacyAttributes<T extends HTMLElement> = JSX.HTMLAttributes<T> & JSX.Properties<T>;

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      // Each caller validates the picker option/callback pairing before the DOM boundary.
      "openclaw-select-picker": HTMLAttributes<SelectPicker> & { "prop:params": unknown };
      "openclaw-update-run-view": HTMLAttributes<HTMLElement> & {
        "prop:run": UpdateRunRecord | null;
        "prop:connected": boolean;
      };
      "openclaw-tooltip": HTMLAttributes<HTMLElementTagNameMap["openclaw-tooltip"]> & {
        "prop:content"?: string;
        placement?: HTMLElementTagNameMap["openclaw-tooltip"]["placement"];
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
          placement?: WaDropdown["placement"];
          "onWa-select"?: (event: CustomEvent<{ item: WaDropdownItem }>) => void;
          "onWa-after-hide"?: (event: CustomEvent<void>) => void;
        };
      "wa-dropdown-item": HTMLAttributes<WaDropdownItem> &
        Properties<WaDropdownItem> &
        Partial<Pick<WaDropdownItem, "value" | "type" | "variant" | "disabled">>;
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
