import {
  createEffect,
  createMemo,
  createRenderEffect,
  createSignal,
  onCleanup,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import { shellLayoutOwnerForHost, type ShellLayoutOwner } from "../../app/shell-layout-owner.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import { LitContent } from "../../lit/solid-content.tsx";
import { ChatComposerCapabilityDialogs } from "./chat-composer-capability-host.tsx";
import { ChatPaneRuntime } from "./chat-pane-render.ts";
import { ChatProviderReviewDialog } from "./chat-provider-review-controller.tsx";
import { createSolidRenderLifecycle } from "./solid-render-lifecycle.ts";

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
  | "presentationTitle"
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
  presentationTitle: { default: undefined },
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
            runtime.requestUpdate(key, previous);
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

function MountedChatPaneRuntime(props: { runtime: ChatPaneRuntime }) {
  const runtime = untrack(() => props.runtime);
  const [presented, setPresented] = createSignal(runtime.presented);
  const [visible, setVisible] = createSignal(document.visibilityState !== "hidden");
  const visibilityChanged = () => runtime.requestUpdate();
  document.addEventListener("visibilitychange", visibilityChanged);
  const lifecycle = createSolidRenderLifecycle({
    host: runtime.element,
    presented: () => presented() && visible(),
    read: () => {
      runtime.prepareRender();
      return runtime.render();
    },
  });
  const unsubscribe = runtime.subscribe(() => {
    setVisible(document.visibilityState !== "hidden");
    setPresented(runtime.presented);
    lifecycle.invalidate();
  });
  const frame = createMemo(() => lifecycle.snapshot());
  createEffect(
    () => frame(),
    () => runtime.commitRender(),
  );
  onCleanup(() => {
    unsubscribe();
    document.removeEventListener("visibilitychange", visibilityChanged);
  });
  return (
    <>
      <LitContent value={frame().layout} />
      <ChatProviderReviewDialog controller={runtime.providerReview} revision={frame()} />
      <Show when={frame().capabilityDialogs}>
        {(dialogs) => <ChatComposerCapabilityDialogs {...dialogs()} />}
      </Show>
    </>
  );
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

export function ChatPaneRuntimeView(props: { runtime: ChatPaneRuntime }) {
  const [ready, setReady] = createSignal(false);
  let initialized = false;
  let layout: ShellLayoutOwner | undefined;
  onSettled(() => {
    // Solid-owned route bridges have no layout provider; the connected host identifies its owner.
    layout = shellLayoutOwnerForHost(props.runtime.element);
    layout?.record(props.runtime, props.runtime.element, { workbench: true });
    if (!props.runtime.isConnected) {
      props.runtime.connectedCallback();
    }
    props.runtime.performUpdate();
    initialized = true;
    setReady(true);
  });
  onCleanup(() => {
    if (initialized) {
      props.runtime.disconnectedCallback();
    }
    layout?.clear(props.runtime);
  });
  return (
    <Show when={ready()}>
      <MountedChatPaneRuntime runtime={props.runtime} />
    </Show>
  );
}
