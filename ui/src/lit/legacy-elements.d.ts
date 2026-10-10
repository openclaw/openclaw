import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import type WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";
import type WaTabGroup from "@awesome.me/webawesome/dist/components/tab-group/tab-group.js";
import type WaTab from "@awesome.me/webawesome/dist/components/tab/tab.js";
import type { JSX } from "@solidjs/web";
import "../components/agent-row-chip.ts";
import type { MascotMood } from "../components/mascot-pose.ts";
import type { SelectPicker } from "../components/select-picker.ts";

// These hosts retain their existing renderer until their owning migration lane lands.
type LegacyAttributes<T extends HTMLElement> = JSX.HTMLAttributes<T> & {
  [Key in keyof T as Key extends string ? `prop:${Key}` : never]?: T[Key];
};

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-select-picker": LegacyAttributes<SelectPicker>;
      "openclaw-agent-row-chip": LegacyAttributes<HTMLElementTagNameMap["openclaw-agent-row-chip"]>;
      "openclaw-mascot": LegacyAttributes<HTMLElement> & {
        mood?: MascotMood;
        "prop:size"?: number;
      };
      "wa-dropdown": LegacyAttributes<WaDropdown> &
        Partial<Pick<WaDropdown, "placement">> & {
          "onWa-select"?: (event: CustomEvent<{ item: WaDropdownItem }>) => void;
        };
      "wa-dropdown-item": LegacyAttributes<WaDropdownItem> &
        Partial<Pick<WaDropdownItem, "value" | "type" | "variant" | "disabled">>;
      "wa-popover": LegacyAttributes<WaPopover> &
        Partial<Pick<WaPopover, "for" | "placement">> & {
          "onWa-show"?: (event: Event) => void;
          "onWa-hide"?: (event: Event) => void;
        };
      "wa-tab-group": LegacyAttributes<WaTabGroup> & Partial<Pick<WaTabGroup, "activation">>;
      "wa-tab": LegacyAttributes<WaTab> & Partial<Pick<WaTab, "panel" | "active">>;
    }
  }
}
