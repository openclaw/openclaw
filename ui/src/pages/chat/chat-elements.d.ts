import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import type { JSX } from "@solidjs/web";
import type { McpAppView } from "../../components/mcp-app-view.ts";
import type { OpenClawModalDialog } from "../../components/modal-dialog.ts";
import type { ChatPane } from "./chat-pane-render.ts";
import type { ChatSubagentActivityLive } from "./components/chat-subagent-activity-live.ts";

type Attributes<T extends HTMLElement> = JSX.HTMLAttributes<T> & JSX.Properties<T>;

/** Properties at the remaining Lit custom-element boundaries used by Solid chat leaves. */
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-pane": Attributes<ChatPane> & {
        "prop:agentId"?: ChatPane["agentId"];
        "prop:onBackToSubagents"?: ChatPane["onBackToSubagents"];
        "prop:onPaneSessionChange"?: ChatPane["onPaneSessionChange"];
      };
      "openclaw-chat-subagent-activity": Attributes<ChatSubagentActivityLive> & {
        "prop:rows"?: ChatSubagentActivityLive["rows"];
        "prop:onOpenSubagent"?: ChatSubagentActivityLive["onOpenSubagent"];
        "prop:onOpenSession"?: ChatSubagentActivityLive["onOpenSession"];
      };
      "mcp-app-view": Attributes<McpAppView>;
      "openclaw-elapsed-time": Attributes<HTMLElement> & {
        "prop:startMs"?: number | null;
        "prop:endMs"?: number | null;
      };
      "openclaw-modal-dialog": Attributes<OpenClawModalDialog> & {
        "onModal-cancel"?: (event: Event) => void;
      };
      "wa-dropdown": Attributes<WaDropdown> & {
        placement?: WaDropdown["placement"];
        "onWa-select"?: (event: CustomEvent<{ item: { value?: string } }>) => void;
      };
      "wa-dropdown-item": Attributes<WaDropdownItem> & {
        value?: string;
        type?: WaDropdownItem["type"];
      };
    }
  }
}
