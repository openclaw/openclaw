import { createRenderEffect, onCleanup } from "solid-js";
import { useApplication } from "../../lib/reactive/context.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { ChatPaneRuntime } from "./chat-pane-render.ts";
import { ChatPaneRuntimeView } from "./chat-pane-runtime-view.tsx";

type PaneProperty =
  | "mcpAppLaunch"
  | "paneId"
  | "paneLabel"
  | "presentationId"
  | "chatMessagesBySession"
  | "sessionSnapshotStore"
  | "sessionKey"
  | "routeLoadingSkeleton"
  | "agentId"
  | "inputRegion"
  | "compact"
  | "onBackToSubagents"
  | "workContext"
  | "visuallyPresented"
  | "presented"
  | "active"
  | "draft"
  | "focusComposer"
  | "dashboardExpanded"
  | "routeFace"
  | "onFaceChange"
  | "onFocusPane"
  | "onPaneSessionChange"
  | "onSessionDeleted"
  | "narrow"
  | "mergedChrome"
  | "navDrawerOpen"
  | "onboarding"
  | "onOpenSplitView"
  | "onSplitDown"
  | "onSplitRight"
  | "onClosePane"
  | "boardProvider";
export type ChatPaneProps = Pick<ChatPaneRuntime, PaneProperty>;
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

const properties = {
  mcpAppLaunch: { default: undefined },
  paneId: { default: "single" },
  paneLabel: { default: undefined },
  presentationId: { default: "single" },
  chatMessagesBySession: { default: undefined },
  sessionSnapshotStore: { default: undefined },
  sessionKey: { default: "" },
  routeLoadingSkeleton: { default: false },
  agentId: { default: undefined },
  inputRegion: { default: "page" as const },
  compact: { default: false },
  onBackToSubagents: { default: undefined },
  workContext: { default: undefined },
  visuallyPresented: { default: true },
  presented: { default: true },
  active: { default: false },
  draft: { default: undefined },
  focusComposer: { default: false },
  dashboardExpanded: { default: false },
  routeFace: { default: undefined },
  onFaceChange: { default: undefined },
  onFocusPane: { default: undefined },
  onPaneSessionChange: { default: undefined },
  onSessionDeleted: { default: undefined },
  narrow: { default: false },
  mergedChrome: { default: false },
  navDrawerOpen: { default: false },
  onboarding: { default: false },
  onOpenSplitView: { default: undefined },
  onSplitDown: { default: undefined },
  onSplitRight: { default: undefined },
  onClosePane: { default: undefined },
  boardProvider: { default: undefined },
} satisfies { [Key in keyof ChatPaneProps]-?: { default: ChatPaneProps[Key] } };

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
      get: () => Promise.resolve(bridgeCompletion()).then(() => runtime.updateComplete),
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
    createRenderEffect(
      () =>
        Object.fromEntries(Object.keys(properties).map((key) => [key, Reflect.get(props, key)])),
      (next) => {
        for (const [key, value] of Object.entries(next)) {
          const previous = Reflect.get(runtime, key);
          if (!Object.is(previous, value)) {
            Reflect.set(runtime, key, value);
            runtime.invalidate();
          }
        }
      },
    );
    onCleanup(() => runtimes.delete(element));
    return <ChatPaneRuntimeView runtime={runtime} />;
  },
  {
    properties,
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
