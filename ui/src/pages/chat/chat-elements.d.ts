import type { JSX } from "@solidjs/web";
import "../../components/modal-dialog.ts";
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
      "openclaw-elapsed-time": Attributes<HTMLElement> & {
        "prop:startMs"?: number | null;
        "prop:endMs"?: number | null;
      };
    }
  }
}
