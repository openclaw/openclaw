import { createComponent, createEffect, createMemo, onCleanup, untrack } from "solid-js";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { ChatPageBody } from "./chat-page-pane-render.tsx";
import { ChatPageState } from "./chat-page-state.ts";
import type { ChatPageHost, ChatPageMethods, ChatPageProps } from "./chat-page-types.ts";
import "../../styles/chat.ts";
import "../../styles/chat/composer.css";

export type ChatPage = ChatPageHost & {
  readonly sessionSplitAvailable: boolean;
};

export const ChatPageView = defineSolidBridge<ChatPageProps, ChatPageMethods>(
  "openclaw-chat-page",
  (props, element) => {
    const host = element;
    const state = ChatPageState.forHost(host);
    const application = untrack(() => props.context ?? useApplication());
    state.context = application;
    Object.defineProperty(host, "sessionSplitAvailable", {
      configurable: true,
      get: () => state.sessionSplitAvailable,
    });
    untrack(() => state.connect());
    const projection = projectSource(state, {
      read: (owner) => owner,
      subscribe: (owner, notify) => owner.subscribe(notify),
      equality: "revision",
    });
    const frame = createMemo(() => {
      projection.read();
      return state.render();
    });
    let lastPresented = untrack(() => props.presented);
    createEffect(
      () => ({
        data: props.data,
        presented: props.presented,
        drawer: props.navDrawerOpen,
        context: props.context,
      }),
      (next) => {
        state.context = next.context ?? application;
        state.requestUpdate();
      },
    );
    createEffect(
      () => ({ owner: projection.read(), frame: frame(), presented: props.presented }),
      (next) => {
        const changed = lastPresented !== next.presented;
        lastPresented = next.presented;
        untrack(() => state.afterCommit(changed, next.frame));
      },
    );
    onCleanup(() => {
      state.disconnect();
    });
    return createComponent(ChatPageBody, {
      get snapshot() {
        return frame();
      },
    });
  },
  {
    properties: {
      data: { default: undefined!, attribute: false },
      navDrawerOpen: { default: false, attribute: false },
      presented: { default: true, type: Boolean },
      context: { default: undefined, attribute: false },
    },
    methods: {
      requestUpdate: (host) => ChatPageState.get(host)?.requestUpdate(),
      addController: (host, controller) => ChatPageState.get(host)?.addController(controller),
      removeController: (host, controller) => ChatPageState.get(host)?.removeController(controller),
    },
  },
);

// SAFETY: defineSolidBridge synchronously registers this exact host contract.
export const ChatPage = customElements.get("openclaw-chat-page") as { new (): ChatPage };
