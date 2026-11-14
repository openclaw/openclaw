import { onCleanup } from "solid-js";
import { useApplication } from "../../lib/reactive/context.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { registerChatPane } from "./chat-pane-elements.ts";
import {
  chatPaneProperties,
  chatPanePropertyKeys,
  type ChatPaneProps,
} from "./chat-pane-inputs.ts";
import { ChatPaneRuntime } from "./chat-pane-render.ts";
import { createChatPaneView } from "./chat-pane-runtime-view.tsx";
import type { ChatPaneInputChanges } from "./chat-pane-state-owner.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";

export type { ChatPaneProps } from "./chat-pane-inputs.ts";
type PaneMethods = Pick<
  ChatPaneRuntime,
  | "prepareForEviction"
  | "discardStagedAttachments"
  | "resumeStagedAttachments"
  | "captureNavigationFace"
  | "focusComposerInput"
>;
export type ChatPaneElement = SolidBridgeElement<ChatPaneProps, PaneMethods> &
  Pick<
    ChatPaneRuntime,
    | "transcriptLoading"
    | "transcriptReady"
    | "historyRecovering"
    | "conversationPresented"
    | "hasQueuedMessageEdit"
    | "runActivity"
    | "composerReady"
  > & {
    readonly composerElement: HTMLTextAreaElement | null;
    readonly headerElement: HTMLElement | null;
  };
const runtimes = new WeakMap<HTMLElement, ChatPaneRuntime>();
const pendingInputs = new WeakSet<ChatPaneRuntime>();

function synchronizeInputs(runtime: ChatPaneRuntime, host: ChatPaneProps) {
  // Publish a queued stream before the input change admits its next pane frame.
  runtime.chatState.publishPendingRunState();
  const changes: ChatPaneInputChanges = {
    sessionKey: !Object.is(runtime.sessionKey, host.sessionKey),
    inputRegion: !Object.is(runtime.inputRegion, host.inputRegion),
    draft: !Object.is(runtime.draft, host.draft),
    focusComposer: !Object.is(runtime.focusComposer, host.focusComposer),
    routeResolutionPending: !Object.is(runtime.routeResolutionPending, host.routeResolutionPending),
  };
  Object.assign(runtime, Object.fromEntries(chatPanePropertyKeys.map((key) => [key, host[key]])));
  if (runtime.isConnected) {
    runtime.synchronizeInputs(changes);
    runtime.refreshBoardSubscriptions();
  }
}

export const ChatPaneView = defineSolidBridge<ChatPaneProps, PaneMethods>(
  "openclaw-chat-pane",
  (_props, element) => {
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
      "composerReady",
    ] as const) {
      Object.defineProperty(element, key, { configurable: true, get: () => runtime[key] });
    }
    Object.defineProperties(element, {
      composerElement: {
        configurable: true,
        get: () => getChatComposerState(runtime.presentationId).composerTextarea,
      },
      headerElement: { configurable: true, get: () => runtime.headerElement },
    });
    // The bridge owns input publication, including while this pane's frame is parked.
    synchronizeInputs(runtime, element);
    // Parent commit work discovers pane membership before child settled callbacks run.
    const unregister = registerChatPane(element);
    onCleanup(() => {
      unregister();
      runtimes.delete(element);
    });
    return createChatPaneView(runtime);
  },
  {
    properties: chatPaneProperties,
    propertyChanged: (host) => {
      const runtime = runtimes.get(host);
      if (!runtime || pendingInputs.has(runtime)) {
        return;
      }
      pendingInputs.add(runtime);
      queueMicrotask(() => {
        pendingInputs.delete(runtime);
        if (runtimes.get(host) === runtime) {
          synchronizeInputs(runtime, host);
        }
      });
      void runtime.awaitDomCommit();
    },
    methods: {
      prepareForEviction: (host) => runtimes.get(host)?.prepareForEviction(),
      discardStagedAttachments: (host) => runtimes.get(host)?.discardStagedAttachments(),
      resumeStagedAttachments: (host) => runtimes.get(host)?.resumeStagedAttachments(),
      captureNavigationFace: (host) => runtimes.get(host)?.captureNavigationFace(),
      focusComposerInput: (host) => runtimes.get(host)?.focusComposerInput() ?? false,
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
