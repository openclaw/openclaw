import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import { LitContent } from "../../lit/solid-content.tsx";
import { ChatComposerCapabilityDialogs } from "./chat-composer-capability-host.tsx";
import type { ChatPaneRuntime } from "./chat-pane-render.ts";
import { ChatProviderReviewDialog } from "./chat-provider-review-controller.tsx";
import { createSolidRenderLifecycle } from "./solid-render-lifecycle.ts";

function MountedChatPaneRuntime(props: { runtime: ChatPaneRuntime }) {
  const runtime = untrack(() => props.runtime);
  runtime.mountPanelActions();
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
