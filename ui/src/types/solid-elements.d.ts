// Importing the module keeps this file a module, so the block below augments it.
import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import "@solidjs/web";
import type { UpdateRunRecord } from "../../../src/infra/update-run-record.ts";
import type { SelectPicker } from "../components/select-picker.ts";
export type { JSX } from "@solidjs/web";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-tooltip": HTMLAttributes<HTMLElement> & { "prop:content": string };
      // Each caller validates PickerParams<Option>; the generic payload crosses
      // this DOM boundary intact, without erasing its option/callback pairing.
      "openclaw-select-picker": HTMLAttributes<SelectPicker> & { "prop:params": unknown };
      "openclaw-agent-memory-panel": HTMLAttributes<HTMLElement> & { "prop:agentId": string };
      "openclaw-update-run-view": HTMLAttributes<HTMLElement> & {
        "prop:run": UpdateRunRecord | null;
        "prop:connected": boolean;
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
