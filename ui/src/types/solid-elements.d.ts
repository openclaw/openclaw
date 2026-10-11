import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import type WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";
import type WaTabGroup from "@awesome.me/webawesome/dist/components/tab-group/tab-group.js";
import type WaTab from "@awesome.me/webawesome/dist/components/tab/tab.js";
import type { JSX } from "@solidjs/web";
import "../components/agent-row-chip.ts";
import type { MascotMood } from "../components/mascot-pose.ts";
import type { OpenClawModalDialog } from "../components/modal-dialog.ts";
import type { SelectPicker } from "../components/select-picker.ts";
export type { JSX } from "@solidjs/web";

// These hosts keep their existing renderer until their owning migration lane lands.
type LegacyAttributes<T extends HTMLElement> = JSX.HTMLAttributes<T> & JSX.Properties<T>;

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-tooltip": HTMLAttributes<HTMLElement> & { "prop:content": string };
      "openclaw-modal-dialog": LegacyAttributes<OpenClawModalDialog> &
        Partial<Pick<OpenClawModalDialog, "label" | "description" | "open" | "manual">> & {
          "onModal-cancel"?: (event: Event) => void;
        };
      "openclaw-select-picker": LegacyAttributes<SelectPicker>;
      "openclaw-agent-row-chip": LegacyAttributes<
        HTMLElementTagNameMap["openclaw-agent-row-chip"]
      > & {
        "prop:agentId"?: HTMLElementTagNameMap["openclaw-agent-row-chip"]["agentId"];
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
          "without-arrow"?: boolean;
          "onWa-show"?: (event: Event) => void;
          "onWa-hide"?: (event: Event) => void;
        };
      "wa-tab-group": LegacyAttributes<WaTabGroup> & Partial<Pick<WaTabGroup, "activation">>;
      "wa-tab": LegacyAttributes<WaTab> & Partial<Pick<WaTab, "panel" | "active">>;
    }
    interface SVGAttributes<T> {
      "xml:space"?: "default" | "preserve";
    }
  }
}
