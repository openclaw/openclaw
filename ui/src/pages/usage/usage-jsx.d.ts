import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import type { JSX } from "@solidjs/web";
import "../../components/agent-row-chip.ts";
import "../../components/session-owner-chip.ts";
import "../../components/tooltip.ts";

type LegacyElement<
  Element extends HTMLElement,
  Property extends keyof Element,
> = JSX.HTMLAttributes<Element> & {
  [Key in Property as `prop:${Key & string}`]?: Element[Key];
};

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-agent-row-chip": LegacyElement<
        HTMLElementTagNameMap["openclaw-agent-row-chip"],
        "agentId"
      >;
      "openclaw-session-owner-chip": LegacyElement<
        HTMLElementTagNameMap["openclaw-session-owner-chip"],
        "owner"
      > & { size?: HTMLElementTagNameMap["openclaw-session-owner-chip"]["size"] };
      "openclaw-tooltip": LegacyElement<HTMLElementTagNameMap["openclaw-tooltip"], "content"> & {
        "open-on-click"?: boolean;
      };
      "wa-dropdown": JSX.HTMLAttributes<WaDropdown> & {
        placement?: WaDropdown["placement"];
        "onWa-select"?: (event: CustomEvent<{ item: WaDropdownItem }>) => void;
      };
      "wa-dropdown-item": LegacyElement<WaDropdownItem, "checked"> & {
        value?: string;
        type?: WaDropdownItem["type"];
        disabled?: boolean;
      };
    }
  }
}
