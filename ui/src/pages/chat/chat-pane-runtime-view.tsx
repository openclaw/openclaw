import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import { i18nRevision } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { useVisiblePoll } from "../../lib/reactive/visible-poll.ts";
import { ChatComposerCapabilityDialogs } from "./chat-composer-capability-host.tsx";
import { PaneLayout } from "./chat-pane-layout-view.tsx";
import type { ChatPaneRuntime } from "./chat-pane-render.ts";
import {
  ChatProviderReviewDialog,
  createChatProviderReview,
  type ChatProviderReviewOwner,
} from "./chat-provider-review-controller.tsx";
import { installChatComposerPickerDismissal } from "./components/chat-picker-overlay.ts";
import { createSolidRenderLifecycle } from "./solid-render-lifecycle.ts";

function MountedChatPaneRuntime(props: { runtime: ChatPaneRuntime }) {
  const runtime = untrack(() => props.runtime);
  runtime.mountPanelActions();
  runtime.mountToolIcons();
  const sources = [runtime.context.plugins, runtime.context.navigation].map((source) =>
    projectSource(source, {
      read: (owner) => owner,
      subscribe: (owner, notify) => owner?.subscribe(notify) ?? (() => {}),
      equality: "revision",
    }),
  );
  onSettled(() => installChatComposerPickerDismissal(runtime.ownerDocument));
  const [presented, setPresented] = createSignal(runtime.presented);
  const [visible, setVisible] = createSignal(document.visibilityState !== "hidden");
  // Relative labels tick only while this retained pane is presented.
  const minutePoll = useVisiblePoll(60_000, () => runtime.requestUpdate());
  const lifecycle = createSolidRenderLifecycle({
    host: runtime.element,
    presented: () => presented() && visible(),
    read: () => {
      i18nRevision();
      sources.forEach((source) => source.read());
      runtime.prepareRender();
      return runtime.render(() => providerReview);
    },
  });
  const unsubscribe = runtime.subscribe(() => {
    setVisible(document.visibilityState !== "hidden");
    setPresented(runtime.presented);
    lifecycle.invalidate();
  });
  const frame = createMemo(() => lifecycle.snapshot());
  const providerReview: ChatProviderReviewOwner = createChatProviderReview({
    source: () => frame().providerReviewSource,
    readState: () => runtime.readProviderReviewState(),
  });
  createEffect(
    () => ({ frame: frame(), presented: presented() }),
    (next, previous) => {
      if (next.frame !== previous?.frame) {
        runtime.commitRender();
      }
      if (next.presented) {
        minutePoll.start();
      } else {
        minutePoll.stop();
      }
    },
  );
  onCleanup(unsubscribe);
  return (
    <>
      <PaneLayout layout={frame().layout} />
      <ChatProviderReviewDialog owner={providerReview} />
      <Show when={frame().capabilityDialogs}>
        {(dialogs) => <ChatComposerCapabilityDialogs {...dialogs()} />}
      </Show>
    </>
  );
}

export function ChatPaneRuntimeView(props: { runtime: ChatPaneRuntime }) {
  const [ready, setReady] = createSignal(false);
  let initialized = false;
  onSettled(() => {
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
  });
  return (
    <Show when={ready()}>
      <MountedChatPaneRuntime runtime={props.runtime} />
    </Show>
  );
}
