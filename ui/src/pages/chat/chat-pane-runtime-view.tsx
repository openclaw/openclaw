import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import {
  availableLinkReaders,
  availableLinkPreviewReaders,
} from "../../app/link-reader-routing.ts";
import { nativeGatewaysCapability } from "../../app/native-gateways.runtime.ts";
import { projectsForGateway } from "../../lib/projects.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { projectProgressCard } from "../../lib/reactive/domain-keyed.ts";
import { i18nRevision } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
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
import { notifyRenderLifecycleForTest } from "./render-lifecycle.ts";
import { createSolidRenderLifecycle } from "./solid-render-lifecycle.ts";

/** One Solid owner publishes, mounts, and retires the synchronous pane runtime. */
export function createChatPaneView(runtime: ChatPaneRuntime) {
  const [ready, setReady] = createSignal(false);
  const [revision, setRevision] = createSignal(0);
  let disposed = false;
  let publicationQueued = false;
  let complete: (() => void) | undefined;
  let previousInputs:
    | Pick<ChatPaneRuntime, "sessionKey" | "inputRegion" | "draft" | "focusComposer">
    | undefined;
  let focusPending = false;

  function publish() {
    if (disposed || !publicationQueued) {
      return;
    }
    runtime.refreshBoardSubscriptions();
    publicationQueued = false;
    setRevision((value) => value + 1);
    if (runtime.presented && document.visibilityState !== "hidden") {
      notifyRenderLifecycleForTest(runtime.element, "invalidate");
    }
  }

  runtime.invalidate = () => {
    if (disposed || !runtime.isConnected) {
      return;
    }
    if (!complete) {
      runtime.updateComplete = new Promise<boolean>((resolve) => {
        complete = () => resolve(true);
      });
    }
    if (!publicationQueued) {
      publicationQueued = true;
      // Domain mutations stay synchronous; rendering retains its microtask boundary.
      queueMicrotask(publish);
    }
  };

  onSettled(() => {
    if (!runtime.isConnected) {
      runtime.start();
    }
    runtime.invalidate();
    // Drain startup before mounting children, as the previous pane lifecycle did.
    publish();
    setReady(true);
  });
  onCleanup(() => {
    disposed = true;
    runtime.dispose();
    complete?.();
    complete = undefined;
    runtime.updateComplete = Promise.resolve(true);
  });

  function prepareRender() {
    const { sessionKey, inputRegion, draft, focusComposer } = runtime;
    const next = { sessionKey, inputRegion, draft, focusComposer };
    const changes = {
      sessionKey: next.sessionKey !== previousInputs?.sessionKey,
      inputRegion: next.inputRegion !== previousInputs?.inputRegion,
      draft: next.draft !== previousInputs?.draft,
      focusComposer: next.focusComposer !== previousInputs?.focusComposer,
    };
    previousInputs = next;
    focusPending ||= changes.focusComposer;
    runtime.chatState.prepareRender();
    runtime.synchronizeInputs(changes);
  }
  function commitRender() {
    const finish = complete;
    complete = undefined;
    runtime.updateComplete = Promise.resolve(true);
    const focus = focusPending;
    focusPending = false;
    runtime.afterRender(focus);
    runtime.chatState.commitRender();
    finish?.();
  }

  function MountedPane() {
    const context = runtime.context;
    const gateway = projectGateway(context.gateway);
    const projects = projectOwner(projectsForGateway(context.gateway), (owner) => owner.snapshot);
    const boardProvider = createMemo(() => {
      revision();
      return runtime.subscribedBoardProvider;
    });
    const board = createMemo(() => {
      const provider = boardProvider();
      return provider
        ? [
            projectOwner(provider.snapshot$, (source) => source.value),
            projectOwner(provider.loadError$, (source) => source.value),
          ]
        : [];
    });
    const presented = () => {
      revision();
      return runtime.presented;
    };
    runtime.mountPanelActions();
    runtime.mountToolIcons(revision);
    const progressScope = createMemo(
      () => {
        revision();
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
    // Seed the watch from the same memo identity its first effect will publish.
    const progress = projectProgressCard(untrack(progressScope));
    const cacheProgress = () => {
      const { target, store, options } = runtime.readProgressCardScope();
      if (target && options.admitAutomaticRead()) {
        runtime.cacheProgressCard(target, store.get(target));
      }
    };
    // Bind the imperative store watch to the current connection and conversation.
    createEffect(progressScope, (next) => progress.replaceSource(next));
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
    ].map((source) => source && projectOwner(source, (capability) => capability));
    onSettled(() => installChatComposerPickerDismissal(runtime.element.ownerDocument));
    // Relative labels tick only while this retained pane is presented.
    const minutePoll = useVisiblePoll(60_000, () => runtime.invalidate());
    const lifecycle = createSolidRenderLifecycle({
      host: runtime.element,
      presented: () => presented() && document.visibilityState !== "hidden",
      read: () => {
        revision();
        progress.read();
        projects.read();
        board().forEach((source) => source.read());
        i18nRevision();
        sources.forEach((source) => source?.read());
        prepareRender();
        return runtime.render(() => providerReview);
      },
    });
    const frame = createMemo(() => lifecycle.snapshot());
    const providerReview: ChatProviderReviewOwner = createChatProviderReview({
      source: () => frame().providerReviewSource,
      readState: () => runtime.readProviderReviewState(),
    });
    // Commit transcript geometry and control the browser timer after Solid publishes the frame.
    createEffect(
      () => ({ frame: frame(), presented: presented() }),
      (next, previous) => {
        if (next.frame !== previous?.frame) {
          commitRender();
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

  return (
    <Show when={ready()}>
      <MountedPane />
    </Show>
  );
}
