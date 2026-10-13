// Public custom-element entrypoint for the Control UI chat pane.
import { ChatPane } from "./chat-pane-render.ts";

if (!customElements.get("openclaw-chat-pane")) {
  customElements.define("openclaw-chat-pane", ChatPane);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-pane": ChatPane;
  }
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-pane": HTMLAttributes<ChatPane> &
        Properties<ChatPane> & {
          "prop:agentId"?: ChatPane["agentId"];
          "prop:mcpAppLaunch"?: ChatPane["mcpAppLaunch"];
          "prop:workContext"?: ChatPane["workContext"];
          "prop:onBackToSubagents"?: ChatPane["onBackToSubagents"];
          "prop:onPaneSessionChange"?: ChatPane["onPaneSessionChange"];
        };
    }
  }
}
