import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import type WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import type { JSX } from "@solidjs/web";
import type { McpAppCatalog } from "../../../components/mcp-app-catalog.ts";
import type { McpAppContextStrip } from "../../../components/mcp-app-context-strip.ts";
import type {
  McpAppResources,
  McpAppResourceMentionDetail,
} from "../../../components/mcp-app-resources.ts";
import type { OpenClawModalDialog } from "../../../components/modal-dialog.ts";

type Properties<Element, Keys extends keyof Element> = {
  [Key in Keys as `prop:${Key & string}`]?: Element[Key];
};

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
      "wa-popup": HTMLAttributes<WaPopup> &
        Properties<
          WaPopup,
          "active" | "anchor" | "placement" | "strategy" | "distance" | "skidding"
        > & {
          active?: boolean;
          placement?: WaPopup["placement"];
          strategy?: WaPopup["strategy"];
          "onWa-reposition"?: EventHandlerUnion<WaPopup, CustomEvent>;
        };
      "wa-dropdown": HTMLAttributes<WaDropdown> &
        Properties<WaDropdown, "open" | "placement" | "distance" | "skidding"> & {
          open?: boolean;
          placement?: WaDropdown["placement"];
          "onWa-show"?: EventHandlerUnion<WaDropdown, CustomEvent>;
          "onWa-after-show"?: EventHandlerUnion<WaDropdown, CustomEvent>;
          "onWa-hide"?: EventHandlerUnion<WaDropdown, CustomEvent>;
          "onWa-after-hide"?: EventHandlerUnion<WaDropdown, CustomEvent>;
          "onWa-select"?: EventHandlerUnion<WaDropdown, CustomEvent<{ item: WaDropdownItem }>>;
        };
      "wa-dropdown-item": HTMLAttributes<WaDropdownItem> &
        Properties<WaDropdownItem, "value" | "disabled" | "checked" | "type"> & {
          value?: string;
          disabled?: boolean;
          checked?: boolean;
          type?: WaDropdownItem["type"];
          variant?: WaDropdownItem["variant"];
          href?: string;
          target?: WaDropdownItem["target"];
          rel?: string;
        };
      "openclaw-modal-dialog": HTMLAttributes<OpenClawModalDialog> &
        Properties<OpenClawModalDialog, "open" | "manual" | "label" | "description"> & {
          label?: string;
          description?: string;
          open?: boolean;
          manual?: boolean;
          "onModal-cancel"?: EventHandlerUnion<OpenClawModalDialog, CustomEvent>;
        };
      "openclaw-mcp-app-catalog": HTMLAttributes<McpAppCatalog> &
        Properties<McpAppCatalog, "sessionKey" | "agentId" | "filePath" | "surface"> & {
          surface?: McpAppCatalog["surface"];
        };
      "openclaw-mcp-app-resources": HTMLAttributes<McpAppResources> &
        Properties<McpAppResources, "sessionKey" | "agentId"> & {
          "onOpenclaw-mcp-app-resource-mention"?: EventHandlerUnion<
            McpAppResources,
            CustomEvent<McpAppResourceMentionDetail>
          >;
        };
      "openclaw-mcp-app-context-strip": HTMLAttributes<McpAppContextStrip> &
        Properties<McpAppContextStrip, "sessionKey" | "agentId">;
    }
  }
}
