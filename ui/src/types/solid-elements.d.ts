import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import type WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";
import type WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import type WaSwitch from "@awesome.me/webawesome/dist/components/switch/switch.js";
import type WaTabGroup from "@awesome.me/webawesome/dist/components/tab-group/tab-group.js";
import type WaTabPanel from "@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js";
import type WaTab from "@awesome.me/webawesome/dist/components/tab/tab.js";
import type { JSX } from "@solidjs/web";
import type { ControlUiSurfaceProps } from "../../../src/plugin-sdk/control-ui.js";
import type { ClawHubRecommendation } from "../../../src/shared/clawhub-recommendations.js";
import type { MascotMood } from "../components/mascot-pose.ts";
import type { MessageActionDetails } from "../pages/chat/components/chat-message-markdown.types.ts";
export type { JSX } from "@solidjs/web";

// Keep ambient tag contracts independent of renderer modules: SDK declarations include this file.
type LegacyAttributes<T extends HTMLElement> = JSX.HTMLAttributes<T> & JSX.Properties<T>;
type Tooltip = HTMLElementTagNameMap["openclaw-tooltip"];

type ElementProperties<T> = { [Key in keyof T as `prop:${string & Key}`]?: T[Key] };

declare module "@solidjs/web" {
  namespace JSX {
    interface EventHandlersElement<T> {
      "onWa-show"?: EventHandlerUnion<T, CustomEvent>;
      "onWa-after-show"?: EventHandlerUnion<T, CustomEvent>;
      "onOpenclaw-composer-dismiss-invocations"?: EventHandlerUnion<T, CustomEvent>;
    }
    interface ExplicitProperties {
      messageActions: MessageActionDetails | null | undefined;
    }
    interface IntrinsicElements {
      "openclaw-plugin-view": HTMLAttributes<HTMLElement> & {
        "prop:surface": "tool-result";
        "prop:props": ControlUiSurfaceProps["tool-result"];
        "prop:defaultView": unknown;
        "prop:presented": boolean;
      };
      "openclaw-message-reaction-picker": HTMLAttributes<HTMLElement> & {
        compact?: boolean;
        placement?: "bottom-start" | "bottom-end";
        "prop:activeEmoji"?: ReadonlySet<string>;
        "prop:onSelect"?: (emoji: string, remove: boolean) => void;
      };
      "openclaw-chat-clawhub-card": HTMLAttributes<HTMLElement> & {
        "prop:recommendation"?: ClawHubRecommendation;
        "prop:agentId"?: string;
      };
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
        "prop:orientation": "horizontal" | "vertical";
        "prop:label": string;
        "prop:splitRatio": number;
        "prop:minRatio": number;
        "prop:maxRatio": number;
        "prop:measureRatio": () => number;
        "prop:measureSize": () => number;
        onResize: (event: CustomEvent<{ splitRatio: number }>) => void;
        "onResize-end"?: () => void;
      };
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
        "prop:openOnClick"?: Tooltip["openOnClick"];
        "prop:disabled"?: Tooltip["disabled"];
        "prop:anchor"?: Tooltip["anchor"];
        "prop:placement"?: Tooltip["placement"];
        "prop:closeDelay"?: Tooltip["closeDelay"];
        "prop:hoverDismissDelay"?: Tooltip["hoverDismissDelay"];
        "prop:delay"?: Tooltip["delay"];
        "prop:autoSize"?: Tooltip["autoSize"];
        content?: string;
        disabled?: boolean;
        placement?: Tooltip["placement"];
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
            "client" | "readers" | "agentId" | "previewSeeds"
          >
        >;
      "openclaw-session-owner-chip": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-session-owner-chip"]
      > &
        ElementProperties<Pick<HTMLElementTagNameMap["openclaw-session-owner-chip"], "owner">> & {
          size?: HTMLElementTagNameMap["openclaw-session-owner-chip"]["size"];
        };
      "openclaw-chat-pdf-preview": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-chat-pdf-preview"]
      > &
        ElementProperties<
          Pick<
            HTMLElementTagNameMap["openclaw-chat-pdf-preview"],
            "src" | "sourceIdentity" | "label" | "mimeType" | "sizeBytes"
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
        > & {
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
