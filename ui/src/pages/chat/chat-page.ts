import { createComponent, onSettled, untrack } from "solid-js";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerSessionSplitHost } from "../../lib/sessions/session-menu-navigation.ts";
import { defineSolidBridge } from "../../lib/solid-bridge.ts";
import { ChatPageBody } from "./chat-page-pane-render.tsx";
import { createChatPageState } from "./chat-page-state.ts";
import type { ChatPageHost, ChatPageProps } from "./chat-page-types.ts";
import "../../styles/chat.ts";
import "../../styles/chat/composer.css";

type ChatPageElement = ChatPageHost & {
  readonly sessionSplitAvailable: boolean;
};

defineSolidBridge<ChatPageProps>(
  "openclaw-chat-page",
  (props, host) => {
    // The fallback application is lifetime-stable; page state follows replacement props.context.
    const application = untrack(() => props.context ?? useApplication());
    const state = createChatPageState(host, props, application);
    Object.defineProperty(host, "sessionSplitAvailable", {
      configurable: true,
      get: state.sessionSplitAvailable,
    });
    onSettled(() => registerSessionSplitHost(host, state.sessionSplitAvailable));
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
      gatewayStatus: { default: null, attribute: false },
      presented: { default: true, type: Boolean },
      context: { default: undefined, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-page": ChatPageElement;
  }
}
