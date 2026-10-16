import { createComponent, untrack } from "solid-js";
import { useApplication } from "../../lib/reactive/context.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { ChatPageBody } from "./chat-page-pane-render.tsx";
import { createChatPageState } from "./chat-page-state.ts";
import type { ChatPageHost, ChatPageProps } from "./chat-page-types.ts";
import "../../styles/chat.ts";
import "../../styles/chat/composer.css";

export type ChatPage = ChatPageHost & {
  readonly sessionSplitAvailable: boolean;
};

defineSolidBridge<ChatPageProps>(
  "openclaw-chat-page",
  (props, host) => {
    const application = untrack(() => props.context ?? useApplication());
    const state = createChatPageState(host, props, application);
    Object.defineProperty(host, "sessionSplitAvailable", {
      configurable: true,
      get: state.sessionSplitAvailable,
    });
    return createComponent(ChatPageBody, {
      get snapshot() {
        return state.snapshot();
      },
      get indicator() {
        return props.data?.creation?.admitted === false ? null : state.sessionDrop.indicator();
      },
      containerRef: state.sessionDrop.containerRef,
    });
  },
  {
    properties: {
      data: { default: undefined!, attribute: false },
      navDrawerOpen: { default: false, attribute: false },
      presented: { default: true, type: Boolean },
      context: { default: undefined, attribute: false },
    },
  },
);

// SAFETY: defineSolidBridge synchronously registers this exact host contract.
export const ChatPage = customElements.get("openclaw-chat-page") as { new (): ChatPage };
