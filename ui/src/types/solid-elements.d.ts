import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import type WaOption from "@awesome.me/webawesome/dist/components/option/option.js";
import type WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";
import type WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import type WaSelect from "@awesome.me/webawesome/dist/components/select/select.js";
import type WaTabGroup from "@awesome.me/webawesome/dist/components/tab-group/tab-group.js";
import type WaTabPanel from "@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js";
import type WaTab from "@awesome.me/webawesome/dist/components/tab/tab.js";
import type { WaTabShowEvent } from "@awesome.me/webawesome/dist/events/tab-show.js";
import type { JSX } from "@solidjs/web";
import type { MascotMood } from "../components/mascot-pose.ts";
export type { JSX } from "@solidjs/web";

// Keep ambient tag contracts independent of renderer modules: SDK declarations include this file.
type LegacyAttributes<T extends HTMLElement> = JSX.HTMLAttributes<T> & JSX.Properties<T>;

type ElementProperties<T> = { [Key in keyof T as `prop:${string & Key}`]?: T[Key] };

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "resizable-divider": Omit<HTMLAttributes<HTMLElement>, "onResize"> & {
        "prop:orientation": "horizontal" | "vertical";
        "prop:label": string;
        "prop:splitRatio": number;
        "prop:minRatio": number;
        "prop:maxRatio": number;
        "prop:measureRatio": () => number;
        "prop:measureSize": () => number;
        onResize: (event: CustomEvent<{ splitRatio: number }>) => void;
        "onResize-end": () => void;
      };
      "openclaw-tooltip": HTMLAttributes<HTMLElementTagNameMap["openclaw-tooltip"]> & {
        "prop:content"?: string;
        "prop:contentTemplate"?: HTMLElementTagNameMap["openclaw-tooltip"]["contentTemplate"];
        "prop:delay"?: number;
        "prop:closeDelay"?: number;
        "prop:hoverDismissDelay"?: number;
        "prop:describe"?: boolean;
        placement?: HTMLElementTagNameMap["openclaw-tooltip"]["placement"];
        "open-on-click"?: boolean;
        "auto-size"?: boolean;
      };
      "openclaw-ip-location": HTMLAttributes<HTMLElementTagNameMap["openclaw-ip-location"]> &
        ElementProperties<Pick<HTMLElementTagNameMap["openclaw-ip-location"], "ip">>;
      "openclaw-link-reader-hovercard-provider": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-link-reader-hovercard-provider"]
      > &
        ElementProperties<
          Pick<
            HTMLElementTagNameMap["openclaw-link-reader-hovercard-provider"],
            "client" | "readers" | "agentId" | "previewSeeds"
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
      "wa-option": HTMLAttributes<WaOption> &
        Properties<WaOption> &
        Partial<Pick<WaOption, "value" | "disabled" | "label">>;
      "wa-popup": HTMLAttributes<WaPopup> &
        Properties<WaPopup> &
        Partial<
          Pick<
            WaPopup,
            "active" | "placement" | "distance" | "skidding" | "arrow" | "flip" | "shift"
          >
        > & {
          "prop:anchor"?: WaPopup["anchor"];
          "onWa-reposition"?: EventHandlerUnion<WaPopup, Event>;
        };
      "wa-select": HTMLAttributes<WaSelect> &
        Properties<WaSelect> &
        Partial<
          Pick<
            WaSelect,
            | "name"
            | "size"
            | "placeholder"
            | "multiple"
            | "maxOptionsVisible"
            | "disabled"
            | "label"
            | "required"
            | "withClear"
          >
        > & {
          "prop:value"?: WaSelect["value"];
          "with-clear"?: boolean;
        };
      "wa-popover": LegacyAttributes<WaPopover> &
        Partial<Pick<WaPopover, "for" | "placement">> & {
          distance?: number | `${number}`;
          "without-arrow"?: boolean;
          "onWa-show"?: (event: Event) => void;
          "onWa-after-show"?: (event: Event) => void;
          "onWa-hide"?: (event: Event) => void;
          "onWa-after-hide"?: (event: Event) => void;
        };
      "wa-tab": HTMLAttributes<WaTab> &
        Properties<WaTab> &
        Partial<Pick<WaTab, "panel" | "active" | "disabled">> & {
          "prop:tabIndex"?: WaTab["tabIndex"];
        };
      "wa-tab-group": HTMLAttributes<WaTabGroup> &
        Properties<WaTabGroup> &
        Partial<
          Pick<WaTabGroup, "active" | "placement" | "activation" | "withoutScrollControls">
        > & {
          "without-scroll-controls"?: boolean;
          "onWa-tab-show"?: EventHandlerUnion<WaTabGroup, WaTabShowEvent>;
        };
      "wa-tab-panel": HTMLAttributes<WaTabPanel> &
        Properties<WaTabPanel> &
        Partial<Pick<WaTabPanel, "name" | "active">>;
    }
    interface SVGAttributes<T> {
      "xml:space"?: "default" | "preserve";
    }
  }
}
