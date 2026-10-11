import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import type WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";
import type WaTabGroup from "@awesome.me/webawesome/dist/components/tab-group/tab-group.js";
import type WaTabPanel from "@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js";
import type WaTab from "@awesome.me/webawesome/dist/components/tab/tab.js";
import type { JSX } from "@solidjs/web";
import type { MascotMood } from "../components/mascot-pose.ts";
export type { JSX } from "@solidjs/web";

// Keep ambient tag contracts independent of renderer modules: SDK declarations include this file.
type LegacyAttributes<T extends HTMLElement> = JSX.HTMLAttributes<T> & JSX.Properties<T>;

type ElementProperties<T> = { [Key in keyof T as `prop:${string & Key}`]?: T[Key] };

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "wa-tab-group": HTMLAttributes<WaTabGroup> & {
        "prop:active": string;
        activation: "auto" | "manual";
        "without-scroll-controls": boolean;
        "onWa-tab-show"?: (event: CustomEvent<{ name: string }>) => void;
      };
      "wa-tab": HTMLAttributes<WaTab> & {
        panel: string;
        "prop:active"?: boolean;
        "prop:tabIndex"?: number;
      };
      "wa-tab-panel": HTMLAttributes<WaTabPanel> & {
        name: string;
        "prop:active": boolean;
      };
      "resizable-divider": Omit<HTMLAttributes<HTMLElement>, "onResize"> & {
        "prop:orientation"?: "horizontal" | "vertical";
        "prop:label": string;
        "prop:splitRatio": number;
        "prop:minRatio": number;
        "prop:maxRatio": number;
        "prop:measureRatio"?: () => number;
        "prop:measureSize"?: () => number;
        onResize: (event: CustomEvent<{ splitRatio: number }>) => void;
        "onResize-end": () => void;
      };
      "openclaw-tooltip": HTMLAttributes<HTMLElementTagNameMap["openclaw-tooltip"]> & {
        "prop:content"?: string;
        "prop:describe"?: boolean;
        placement?: HTMLElementTagNameMap["openclaw-tooltip"]["placement"];
        "open-on-click"?: boolean;
        "auto-size"?: boolean;
      };
      "openclaw-viewer-facepile": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-viewer-facepile"]
      > &
        ElementProperties<
          Pick<
            HTMLElementTagNameMap["openclaw-viewer-facepile"],
            "staticParticipants" | "totalCount" | "maxVisible" | "personActivity"
          >
        >;
      "openclaw-viewer-avatar": HTMLAttributes<HTMLElementTagNameMap["openclaw-viewer-avatar"]> &
        ElementProperties<
          Pick<
            HTMLElementTagNameMap["openclaw-viewer-avatar"],
            "identity" | "user" | "markAsViewer"
          >
        > & { variant?: HTMLElementTagNameMap["openclaw-viewer-avatar"]["variant"] };
      "openclaw-ip-location": HTMLAttributes<HTMLElementTagNameMap["openclaw-ip-location"]> &
        ElementProperties<Pick<HTMLElementTagNameMap["openclaw-ip-location"], "ip">>;
      "openclaw-link-reader-hovercard-provider": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-link-reader-hovercard-provider"]
      > &
        ElementProperties<
          Pick<
            HTMLElementTagNameMap["openclaw-link-reader-hovercard-provider"],
            | "client"
            | "readers"
            | "agentId"
            | "previewSeeds"
            | "pagePreviewContext"
            | "claimedReaders"
          >
        >;
      "openclaw-session-owner-chip": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-session-owner-chip"]
      > &
        ElementProperties<Pick<HTMLElementTagNameMap["openclaw-session-owner-chip"], "owner">> & {
          size?: HTMLElementTagNameMap["openclaw-session-owner-chip"]["size"];
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
