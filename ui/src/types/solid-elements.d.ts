import "@solidjs/web";
export type { JSX } from "@solidjs/web";
import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import type WaOption from "@awesome.me/webawesome/dist/components/option/option.js";
import type WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import type WaSelect from "@awesome.me/webawesome/dist/components/select/select.js";
import type WaTabGroup from "@awesome.me/webawesome/dist/components/tab-group/tab-group.js";
import type WaTabPanel from "@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js";
import type WaTab from "@awesome.me/webawesome/dist/components/tab/tab.js";
import type { WaSelectEvent } from "@awesome.me/webawesome/dist/events/select.js";
import type { WaTabShowEvent } from "@awesome.me/webawesome/dist/events/tab-show.js";
import "../components/agent-avatar.ts";
import type { CatalogSessionMenu } from "../components/catalog-session-menu.ts";
import "../components/channel-avatar.ts";
import type { ElapsedTime } from "../components/elapsed-time.ts";
import type { ApprovalCountdown } from "../components/exec-approval-card.ts";
import "../components/mcp-app-catalog.tsx";
import "../components/menu-surface.ts";
import type { RelativeTime } from "../components/relative-time.ts";
import type { SelectPicker } from "../components/select-picker.ts";
import type { SessionMenu } from "../components/session-menu.ts";
import "../components/session-owner-chip.ts";
import type { ThemeBrandIcon } from "../components/theme-brand-icon.ts";
import type { ThemeModeToggle } from "../components/theme-mode-toggle.ts";
import "../components/tooltip.ts";
import "../components/viewer-facepile.ts";
import type {
  ControlUiPluginView,
  ControlUiPluginContributions,
} from "../plugins/control-ui-view.runtime.ts";

// Unported custom elements keep their own typed property and DOM-event contracts.
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-agent-avatar": HTMLAttributes<HTMLElementTagNameMap["openclaw-agent-avatar"]> &
        Properties<HTMLElementTagNameMap["openclaw-agent-avatar"]> & {
          "prop:option"?: HTMLElementTagNameMap["openclaw-agent-avatar"]["option"];
          "prop:identity"?: HTMLElementTagNameMap["openclaw-agent-avatar"]["identity"];
        };
      "openclaw-approval-countdown": HTMLAttributes<ApprovalCountdown> &
        Properties<ApprovalCountdown>;
      "openclaw-catalog-session-menu": HTMLAttributes<CatalogSessionMenu> &
        Properties<CatalogSessionMenu> & {
          "prop:onAction"?: CatalogSessionMenu["onAction"];
          "prop:onClose"?: CatalogSessionMenu["onClose"];
        };
      "openclaw-channel-avatar": HTMLAttributes<HTMLElementTagNameMap["openclaw-channel-avatar"]> &
        Properties<HTMLElementTagNameMap["openclaw-channel-avatar"]> & {
          "prop:authTokens"?: HTMLElementTagNameMap["openclaw-channel-avatar"]["authTokens"];
        };
      "openclaw-elapsed-time": HTMLAttributes<ElapsedTime> & Properties<ElapsedTime>;
      "openclaw-mcp-app-catalog": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-mcp-app-catalog"]
      > &
        Properties<HTMLElementTagNameMap["openclaw-mcp-app-catalog"]> &
        Partial<Pick<HTMLElementTagNameMap["openclaw-mcp-app-catalog"], "surface">>;
      "openclaw-menu-surface": HTMLAttributes<HTMLElementTagNameMap["openclaw-menu-surface"]> &
        Properties<HTMLElementTagNameMap["openclaw-menu-surface"]>;
      "openclaw-plugin-contributions": HTMLAttributes<ControlUiPluginContributions> &
        Properties<ControlUiPluginContributions> & {
          "prop:agentId"?: ControlUiPluginContributions["agentId"];
          "prop:navigationMenus"?: ControlUiPluginContributions["navigationMenus"];
        };
      "openclaw-plugin-view": HTMLAttributes<ControlUiPluginView> &
        Properties<ControlUiPluginView> & {
          "prop:props"?: ControlUiPluginView["props"];
          "prop:defaultView"?: ControlUiPluginView["defaultView"];
          "prop:mountDefaultView"?: ControlUiPluginView["mountDefaultView"];
          "prop:replacementCompanion"?: ControlUiPluginView["replacementCompanion"];
          "prop:defaultHost"?: ControlUiPluginView["defaultHost"];
        };
      "openclaw-relative-time": HTMLAttributes<RelativeTime> & Properties<RelativeTime>;
      "openclaw-select-picker": HTMLAttributes<SelectPicker> &
        Properties<SelectPicker> & {
          "prop:params"?: SelectPicker["params"];
        };
      "openclaw-session-menu": HTMLAttributes<SessionMenu> &
        Properties<SessionMenu> & {
          "prop:session"?: SessionMenu["session"];
          "prop:anchor"?: SessionMenu["anchor"];
          "prop:actionDisabledReasons"?: SessionMenu["actionDisabledReasons"];
          "prop:groups"?: SessionMenu["groups"];
          "prop:currentOwner"?: SessionMenu["currentOwner"];
          "prop:work"?: SessionMenu["work"];
          "prop:pluginActions"?: SessionMenu["pluginActions"];
          "prop:onAction"?: SessionMenu["onAction"];
          "prop:onClose"?: SessionMenu["onClose"];
        };
      "openclaw-session-owner-chip": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-session-owner-chip"]
      > &
        Properties<HTMLElementTagNameMap["openclaw-session-owner-chip"]> &
        Partial<
          Pick<HTMLElementTagNameMap["openclaw-session-owner-chip"], "size" | "attribution">
        > & {
          "prop:owner"?: HTMLElementTagNameMap["openclaw-session-owner-chip"]["owner"];
          "prop:viewingNow"?: HTMLElementTagNameMap["openclaw-session-owner-chip"]["viewingNow"];
          "prop:participants"?: HTMLElementTagNameMap["openclaw-session-owner-chip"]["participants"];
        };
      "openclaw-theme-brand-icon": HTMLAttributes<ThemeBrandIcon> &
        Properties<ThemeBrandIcon> & {
          "prop:branding"?: ThemeBrandIcon["branding"];
        };
      "openclaw-theme-mode-toggle": HTMLAttributes<ThemeModeToggle> & Properties<ThemeModeToggle>;
      "openclaw-tooltip": HTMLAttributes<HTMLElementTagNameMap["openclaw-tooltip"]> &
        Properties<HTMLElementTagNameMap["openclaw-tooltip"]> & {
          "prop:content"?: string;
          placement?: HTMLElementTagNameMap["openclaw-tooltip"]["placement"];
          "prop:contentTemplate"?: HTMLElementTagNameMap["openclaw-tooltip"]["contentTemplate"];
          "prop:hoverDismissDelay"?: HTMLElementTagNameMap["openclaw-tooltip"]["hoverDismissDelay"];
          "prop:delay"?: HTMLElementTagNameMap["openclaw-tooltip"]["delay"];
          "open-on-click"?: boolean;
          "auto-size"?: boolean;
        };
      "openclaw-viewer-avatar": HTMLAttributes<HTMLElementTagNameMap["openclaw-viewer-avatar"]> &
        Properties<HTMLElementTagNameMap["openclaw-viewer-avatar"]> &
        Partial<Pick<HTMLElementTagNameMap["openclaw-viewer-avatar"], "variant">> & {
          "prop:user"?: HTMLElementTagNameMap["openclaw-viewer-avatar"]["user"];
          "prop:identity"?: HTMLElementTagNameMap["openclaw-viewer-avatar"]["identity"];
        };
      "openclaw-viewer-facepile": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-viewer-facepile"]
      > &
        Properties<HTMLElementTagNameMap["openclaw-viewer-facepile"]> & {
          "prop:presencePayload"?: HTMLElementTagNameMap["openclaw-viewer-facepile"]["presencePayload"];
          "prop:selfUser"?: HTMLElementTagNameMap["openclaw-viewer-facepile"]["selfUser"];
          "prop:selfInstanceId"?: HTMLElementTagNameMap["openclaw-viewer-facepile"]["selfInstanceId"];
          "prop:sessionKey"?: HTMLElementTagNameMap["openclaw-viewer-facepile"]["sessionKey"];
          "prop:excludeIdentities"?: HTMLElementTagNameMap["openclaw-viewer-facepile"]["excludeIdentities"];
          "prop:staticParticipants"?: HTMLElementTagNameMap["openclaw-viewer-facepile"]["staticParticipants"];
          "prop:staticUsers"?: HTMLElementTagNameMap["openclaw-viewer-facepile"]["staticUsers"];
          "prop:totalCount"?: HTMLElementTagNameMap["openclaw-viewer-facepile"]["totalCount"];
          "prop:personActivity"?: HTMLElementTagNameMap["openclaw-viewer-facepile"]["personActivity"];
        };
      "wa-dropdown": HTMLAttributes<WaDropdown> &
        Properties<WaDropdown> &
        Partial<Pick<WaDropdown, "open" | "size" | "placement" | "distance" | "skidding">> & {
          "onWa-select"?: EventHandlerUnion<WaDropdown, WaSelectEvent>;
          "onWa-show"?: EventHandlerUnion<WaDropdown, Event>;
          "onWa-after-show"?: EventHandlerUnion<WaDropdown, Event>;
          "onWa-hide"?: EventHandlerUnion<WaDropdown, Event>;
          "onWa-after-hide"?: EventHandlerUnion<WaDropdown, Event>;
        };
      "wa-dropdown-item": HTMLAttributes<WaDropdownItem> &
        Properties<WaDropdownItem> &
        Partial<
          Pick<
            WaDropdownItem,
            | "variant"
            | "size"
            | "value"
            | "type"
            | "checked"
            | "disabled"
            | "href"
            | "target"
            | "rel"
          >
        >;
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
