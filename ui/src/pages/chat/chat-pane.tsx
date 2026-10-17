import { createRenderEffect, onCleanup } from "solid-js";
import { useApplication } from "../../lib/reactive/context.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import {
  chatPaneProperties,
  chatPanePropertyKeys,
  type ChatPaneProps,
} from "./chat-pane-inputs.ts";
import { ChatPaneRuntime } from "./chat-pane-render.ts";
import { createChatPaneView } from "./chat-pane-runtime-view.tsx";
import type { ChatPaneInputChanges } from "./chat-pane-state-owner.ts";

export type { ChatPaneProps } from "./chat-pane-inputs.ts";
type PaneMethods = Pick<
  ChatPaneRuntime,
  | "prepareForEviction"
  | "discardStagedAttachments"
  | "resumeStagedAttachments"
  | "captureNavigationFace"
>;
type PaneFacts = Pick<
  ChatPaneRuntime,
  | "transcriptLoading"
  | "transcriptReady"
  | "historyRecovering"
  | "conversationPresented"
  | "hasQueuedMessageEdit"
  | "runActivity"
>;
export type ChatPaneElement = SolidBridgeElement<ChatPaneProps, PaneMethods> & PaneFacts;
const runtimes = new WeakMap<HTMLElement, ChatPaneRuntime>();

export const ChatPaneView = defineSolidBridge<ChatPaneProps, PaneMethods>(
  "openclaw-chat-pane",
  (props, element) => {
    const runtime = new ChatPaneRuntime(element, useApplication());
    runtimes.set(element, runtime);
    const bridgeCompletion = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element),
      "updateComplete",
    )?.get?.bind(element);
    if (!bridgeCompletion) {
      throw new Error("Chat pane requires the bridge commit fence");
    }
    Object.defineProperty(element, "updateComplete", {
      configurable: true,
      get: () => {
        const frame = runtime.updateComplete;
        return Promise.resolve(bridgeCompletion()).then(() => frame);
      },
    });
    for (const key of [
      "transcriptLoading",
      "transcriptReady",
      "historyRecovering",
      "conversationPresented",
      "hasQueuedMessageEdit",
      "runActivity",
    ] as const) {
      Object.defineProperty(element, key, { configurable: true, get: () => runtime[key] });
    }
    // Native callers and pane startup need synchronous input facts before the first render.
    createRenderEffect(
      () => Object.fromEntries(chatPanePropertyKeys.map((key) => [key, props[key]])),
      (next) => {
        const changes: ChatPaneInputChanges = {
          sessionKey: !Object.is(runtime.sessionKey, next.sessionKey),
          inputRegion: !Object.is(runtime.inputRegion, next.inputRegion),
          draft: !Object.is(runtime.draft, next.draft),
          focusComposer: !Object.is(runtime.focusComposer, next.focusComposer),
        };
        Object.assign(runtime, next);
        if (runtime.isConnected) {
          // Input ownership and ordered commands remain live while the frame is parked.
          runtime.synchronizeInputs(changes);
          runtime.refreshBoardSubscriptions();
        }
      },
    );
    onCleanup(() => runtimes.delete(element));
    return createChatPaneView(runtime);
  },
  {
    properties: chatPaneProperties,
    propertyChanged: (host) => {
      void runtimes.get(host)?.awaitDomCommit();
    },
    methods: {
      prepareForEviction: (host) => runtimes.get(host)?.prepareForEviction(),
      discardStagedAttachments: (host) => runtimes.get(host)?.discardStagedAttachments(),
      resumeStagedAttachments: (host) => runtimes.get(host)?.resumeStagedAttachments(),
      captureNavigationFace: (host) => runtimes.get(host)?.captureNavigationFace(),
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-pane": ChatPaneElement;
  }
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-pane": HTMLAttributes<ChatPaneElement> & {
        [Key in keyof ChatPaneProps as `prop:${Key}`]?: ChatPaneProps[Key];
      };
    }
  }
}
