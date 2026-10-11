import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import type WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import type { McpAppCatalog } from "../../../components/mcp-app-catalog.ts";
import type { McpAppContextStrip } from "../../../components/mcp-app-context-strip.ts";
import type {
  McpAppResources,
  McpAppResourceMentionDetail,
} from "../../../components/mcp-app-resources.ts";
import type { OpenClawModalDialog } from "../../../components/modal-dialog.ts";

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-mcp-app-catalog": McpAppCatalog;
    "openclaw-mcp-app-resources": McpAppResources;
    "openclaw-mcp-app-context-strip": McpAppContextStrip;
  }
}

declare module "@solidjs/web" {
  namespace JSX {
    interface EventHandlersElement<T> {
      "onWa-show"?: EventHandlerUnion<T, CustomEvent>;
      "onWa-after-show"?: EventHandlerUnion<T, CustomEvent>;
      "onOpenclaw-composer-dismiss-invocations"?: EventHandlerUnion<T, CustomEvent>;
    }

    interface IntrinsicElements {
      "wa-popup": HTMLAttributes<WaPopup> & {
        "prop:active"?: WaPopup["active"];
        "prop:anchor"?: WaPopup["anchor"];
        "prop:placement"?: WaPopup["placement"];
        "prop:strategy"?: WaPopup["strategy"];
        "prop:distance"?: WaPopup["distance"];
        "prop:skidding"?: WaPopup["skidding"];
        active?: boolean;
        placement?: WaPopup["placement"];
        strategy?: WaPopup["strategy"];
        "onWa-reposition"?: EventHandlerUnion<WaPopup, CustomEvent>;
      };
      "wa-dropdown": HTMLAttributes<WaDropdown> & {
        "prop:open"?: WaDropdown["open"];
        "prop:placement"?: WaDropdown["placement"];
        "prop:distance"?: WaDropdown["distance"];
        "prop:skidding"?: WaDropdown["skidding"];
        open?: boolean;
        placement?: WaDropdown["placement"];
        "onWa-show"?: EventHandlerUnion<WaDropdown, CustomEvent>;
        "onWa-after-show"?: EventHandlerUnion<WaDropdown, CustomEvent>;
        "onWa-hide"?: EventHandlerUnion<WaDropdown, CustomEvent>;
        "onWa-after-hide"?: EventHandlerUnion<WaDropdown, CustomEvent>;
        "onWa-select"?: EventHandlerUnion<WaDropdown, CustomEvent<{ item: WaDropdownItem }>>;
      };
      "wa-dropdown-item": HTMLAttributes<WaDropdownItem> & {
        "prop:value"?: WaDropdownItem["value"];
        "prop:disabled"?: WaDropdownItem["disabled"];
        "prop:checked"?: WaDropdownItem["checked"];
        "prop:type"?: WaDropdownItem["type"];
        value?: string;
        disabled?: boolean;
        checked?: boolean;
        type?: WaDropdownItem["type"];
        variant?: WaDropdownItem["variant"];
        href?: string;
        target?: WaDropdownItem["target"];
        rel?: string;
      };
      "openclaw-modal-dialog": HTMLAttributes<OpenClawModalDialog> & {
        "prop:open"?: OpenClawModalDialog["open"];
        "prop:manual"?: OpenClawModalDialog["manual"];
        "prop:label"?: OpenClawModalDialog["label"];
        "prop:description"?: OpenClawModalDialog["description"];
        label?: string;
        description?: string;
        open?: boolean;
        manual?: boolean;
        "onModal-cancel"?: EventHandlerUnion<OpenClawModalDialog, CustomEvent>;
      };
      "openclaw-mcp-app-catalog": HTMLAttributes<McpAppCatalog> & {
        "prop:sessionKey"?: McpAppCatalog["sessionKey"];
        "prop:agentId"?: McpAppCatalog["agentId"];
        "prop:filePath"?: McpAppCatalog["filePath"];
        "prop:surface"?: McpAppCatalog["surface"];
        surface?: McpAppCatalog["surface"];
      };
      "openclaw-mcp-app-resources": HTMLAttributes<McpAppResources> & {
        "prop:sessionKey"?: McpAppResources["sessionKey"];
        "prop:agentId"?: McpAppResources["agentId"];
        "onOpenclaw-mcp-app-resource-mention"?: EventHandlerUnion<
          McpAppResources,
          CustomEvent<McpAppResourceMentionDetail>
        >;
      };
      "openclaw-mcp-app-context-strip": HTMLAttributes<McpAppContextStrip> & {
        "prop:sessionKey"?: McpAppContextStrip["sessionKey"];
        "prop:agentId"?: McpAppContextStrip["agentId"];
      };
    }
  }
}
