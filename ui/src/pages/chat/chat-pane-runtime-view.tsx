import { createEffect, createMemo, onSettled, Show, untrack } from "solid-js";
import {
  availableLinkReaders,
  availableLinkPreviewReaders,
} from "../../app/link-reader-routing.ts";
import { nativeGatewaysCapability } from "../../app/native-gateways.runtime.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { projectProgressCard } from "../../lib/reactive/domain-keyed.ts";
import { i18nRevision } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { useVisiblePoll } from "../../lib/reactive/visible-poll.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { ChatComposerCapabilityDialogs } from "./chat-composer-capability-host.tsx";
import { PaneLayout } from "./chat-pane-layout-view.tsx";
import type { ChatPaneRuntime } from "./chat-pane-render.ts";
import {
  ChatProviderReviewDialog,
  createChatProviderReview,
  type ChatProviderReviewOwner,
} from "./chat-provider-review-controller.tsx";
import { installChatComposerPickerDismissal } from "./components/chat-picker-overlay.ts";
import { createChatPane, type ChatPaneOwner } from "./create-chat-pane.ts";
import { createSolidRenderLifecycle } from "./solid-render-lifecycle.ts";

function MountedChatPaneRuntime(props: { pane: ChatPaneOwner }) {
  // One runtime belongs to this mounted pane for its entire lifetime.
  const pane = untrack(() => props.pane);
  const runtime = pane.runtime;
  const context = runtime.context;
  const gateway = projectGateway(context.gateway);
  const presented = () => {
    pane.revision();
    return runtime.presented;
  };
  runtime.mountPanelActions();
  runtime.mountToolIcons(pane.revision);
  const progressScope = createMemo(
    () => {
      pane.revision();
      return runtime.readProgressCardScope();
    },
    {
      equals: (a, b) =>
        a.store === b.store &&
        a.client === b.client &&
        a.hello === b.hello &&
        a.target?.sessionKey === b.target?.sessionKey &&
        a.target?.agentId === b.target?.agentId,
    },
  );
  // The initial binding is replaced by the scope effect before subsequent reads.
  let progressBinding = untrack(progressScope);
  const progress = projectProgressCard(progressBinding);
  const cacheProgress = () => {
    const { target, store, options } = progressBinding;
    if (target && options.admitAutomaticRead()) {
      runtime.cacheProgressCard(target, store.get(target));
    }
  };
  // Bind the imperative store watch to the current connection and conversation.
  createEffect(progressScope, (next) => {
    progressBinding = next;
    progress.replaceSource(next);
  });
  onSettled(() => {
    // Parking may stop rendering, but reset/delete events must still retire card lifetimes.
    const stop = progress.subscribe(cacheProgress);
    cacheProgress();
    return stop;
  });
  const sources = [
    runtime.context.plugins,
    runtime.context.navigation,
    nativeGatewaysCapability(),
  ].map((source) =>
    projectSource(source, {
      read: (capability) => capability,
      subscribe: (capability, notify) => capability?.subscribe(notify) ?? (() => {}),
      equality: "revision",
    }),
  );
  onSettled(() => installChatComposerPickerDismissal(runtime.element.ownerDocument));
  // Relative labels tick only while this retained pane is presented.
  const minutePoll = useVisiblePoll(60_000, () => runtime.invalidate());
  const lifecycle = createSolidRenderLifecycle({
    host: runtime.element,
    presented: () => presented() && document.visibilityState !== "hidden",
    read: () => {
      pane.revision();
      progress.read();
      i18nRevision();
      sources.forEach((source) => source.read());
      pane.prepareRender();
      return runtime.render(() => providerReview);
    },
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
        pane.commitRender();
      }
      if (next.presented) {
        minutePoll.start();
      } else {
        minutePoll.stop();
      }
    },
  );
  const sessionKey = () => {
    frame();
    return runtime.sessionKey;
  };
  const agentId = () => {
    frame();
    return runtime.agentId ?? parseAgentSessionKey(runtime.sessionKey)?.agentId;
  };
  // Keep this passthrough host cold: the shared hover bootstrap upgrades it on intent.
  // Importing its renderer here makes the optional runtime a required boot dependency.
  return (
    <openclaw-link-reader-hovercard-provider
      prop:client={
        gateway.read().snapshot.phase === "connected" ? gateway.read().snapshot.client : null
      }
      prop:readers={availableLinkPreviewReaders(gateway.read().snapshot)}
      prop:claimedReaders={availableLinkReaders(gateway.read().snapshot)}
      prop:pagePreviewContext={context}
      prop:agentId={agentId()}
      prop:sessionKey={sessionKey()}
    >
      <PaneLayout layout={frame().layout} />
      <ChatProviderReviewDialog owner={providerReview} />
      <Show when={frame().capabilityDialogs}>
        {(dialogs) => <ChatComposerCapabilityDialogs {...dialogs()} />}
      </Show>
    </openclaw-link-reader-hovercard-provider>
  );
}

export function ChatPaneRuntimeView(props: { runtime: ChatPaneRuntime }) {
  // The bridge keeps this runtime identity for the mounted pane's lifetime.
  const pane = createChatPane({ runtime: untrack(() => props.runtime) });
  return (
    <Show when={pane.ready()}>
      <MountedChatPaneRuntime pane={pane} />
    </Show>
  );
}
