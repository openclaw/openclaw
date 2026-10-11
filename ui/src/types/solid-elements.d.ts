// Importing the module keeps this file a module, so the block below augments it.
import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import type WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import type WaSwitch from "@awesome.me/webawesome/dist/components/switch/switch.js";
import "../components/mcp-app-catalog.tsx";
import type { McpAppResourceMentionDetail } from "../components/mcp-app-resources.tsx";
import type { OpenClawModalDialog } from "../components/modal-dialog.ts";
import type { McpAppContextStripElement as McpAppContextStrip } from "../components/solid/mcp-app-context-strip.tsx";
import type { ChatPastedText } from "../pages/chat/components/chat-pasted-text.ts";
import type { ChatQuestionCard } from "../pages/chat/components/chat-question-card.ts";
import "@solidjs/web";
import "../components/tooltip.ts";
export type { JSX } from "@solidjs/web";

type Tooltip = HTMLElementTagNameMap["openclaw-tooltip"];
type McpAppCatalog = HTMLElementTagNameMap["openclaw-mcp-app-catalog"];
type McpAppResources = HTMLElementTagNameMap["openclaw-mcp-app-resources"];

declare global {
  interface HTMLElementTagNameMap {
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
        Properties<WaPopup> & {
          active?: boolean;
          placement?: WaPopup["placement"];
          strategy?: WaPopup["strategy"];
          "onWa-reposition"?: EventHandlerUnion<WaPopup, CustomEvent>;
        };
      "wa-switch": HTMLAttributes<WaSwitch> &
        Properties<WaSwitch> & {
          size?: WaSwitch["size"];
          checked?: boolean;
          disabled?: boolean;
        };
      "openclaw-modal-dialog": HTMLAttributes<OpenClawModalDialog> &
        Properties<OpenClawModalDialog> & {
          label?: string;
          description?: string;
          open?: boolean;
          manual?: boolean;
          "onModal-cancel"?: EventHandlerUnion<OpenClawModalDialog, CustomEvent>;
        };
      "openclaw-chat-pasted-text": HTMLAttributes<ChatPastedText> & {
        "prop:src"?: ChatPastedText["src"];
        "prop:sizeBytes"?: ChatPastedText["sizeBytes"];
        "prop:scope"?: ChatPastedText["scope"];
        "prop:onOpen"?: ChatPastedText["onOpen"];
        "prop:composerAction"?: ChatPastedText["composerAction"];
        "prop:composerRemoveAction"?: ChatPastedText["composerRemoveAction"];
      };
      "openclaw-chat-question-card": HTMLAttributes<ChatQuestionCard> & {
        "prop:props"?: ChatQuestionCard["props"];
      };
      "openclaw-mcp-app-catalog": HTMLAttributes<McpAppCatalog> &
        Properties<McpAppCatalog> & {
          surface?: McpAppCatalog["surface"];
        };
      "openclaw-mcp-app-resources": HTMLAttributes<McpAppResources> &
        Properties<McpAppResources> & {
          "onOpenclaw-mcp-app-resource-mention"?: EventHandlerUnion<
            McpAppResources,
            CustomEvent<McpAppResourceMentionDetail>
          >;
        };
      "openclaw-mcp-app-context-strip": HTMLAttributes<McpAppContextStrip> &
        Properties<McpAppContextStrip>;

      "openclaw-tooltip": HTMLAttributes<Tooltip> & {
        "prop:content"?: Tooltip["content"];
        "prop:contentTemplate"?: Tooltip["contentTemplate"];
        "prop:describe"?: Tooltip["describe"];
        "prop:disabled"?: Tooltip["disabled"];
        "prop:anchor"?: Tooltip["anchor"];
        "prop:placement"?: Tooltip["placement"];
        content?: string;
        disabled?: boolean;
        "open-on-click"?: boolean;
        placement?: Tooltip["placement"];
        "auto-size"?: boolean;
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
        Properties<WaDropdownItem> & {
          value?: string;
          disabled?: boolean;
          checked?: boolean;
          type?: WaDropdownItem["type"];
          variant?: WaDropdownItem["variant"];
          href?: string;
          target?: WaDropdownItem["target"];
          rel?: string;
        };
    }
    interface SVGAttributes<T> {
      "xml:space"?: "default" | "preserve";
    }
  }
}
