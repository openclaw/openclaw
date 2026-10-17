import {
  createEffect,
  createMemo,
  createSignal,
  getOwner,
  onCleanup,
  onSettled,
  runWithOwner,
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
import { projectTheme } from "../../lib/reactive/theme.ts";
import { useVisiblePoll } from "../../lib/reactive/visible-poll.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { ChatComposerCapabilityDialogs } from "./chat-composer-capability-host.tsx";
import { projectChatFields } from "./chat-field-projection.ts";
import { chatGoalOperations } from "./chat-goals.ts";
import { PaneLayout } from "./chat-pane-layout-view.tsx";
import type { ChatPaneRuntime } from "./chat-pane-render.ts";
import { lazySidebarElements } from "./chat-pane-sidebar-layout.ts";
import {
  ChatProviderReviewDialog,
  createChatProviderReview,
  type ChatProviderReviewOwner,
} from "./chat-provider-review-controller.tsx";
import { installChatComposerPickerDismissal } from "./components/chat-picker-overlay.ts";
import { sessionWorkspaceForHost } from "./components/chat-session-workspace-state.ts";
import { notifyRenderLifecycleForTest } from "./render-lifecycle.ts";
import { createSolidRenderLifecycle } from "./solid-render-lifecycle.ts";

/** One Solid owner publishes, mounts, and retires the synchronous pane runtime. */
export function createChatPaneView(runtime: ChatPaneRuntime) {
  const viewOwner = getOwner();
  projectChatFields(runtime.tasks);
  projectChatFields(runtime.publication);
  projectChatFields(runtime.repository);
  projectChatFields(runtime.headerPresentation);
  projectChatFields(runtime.collaboration);
  projectChatFields(runtime.swarm);
  const [ready, setReady] = createSignal(false);
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  let disposed = false;
  let complete: (() => void) | undefined;
  let previousInputs:
    | Pick<ChatPaneRuntime, "sessionKey" | "inputRegion" | "draft" | "focusComposer">
    | undefined;
  let focusPending = false;

  runtime.invalidate = () => {
    if (disposed || !runtime.isConnected) {
      return;
    }
    if (!complete) {
      runtime.updateComplete = new Promise<boolean>((resolve) => {
        complete = () => resolve(true);
      });
    }
    runtime.refreshBoardSubscriptions();
    // Solid batches this with field publications; a second microtask would render twice.
    setRevision((value) => value + 1);
    if (runtime.presented && document.visibilityState !== "hidden") {
      notifyRenderLifecycleForTest(runtime.element, "invalidate");
    }
  };

  onSettled(() => {
    if (!runtime.isConnected) {
      // Startup creates projections that belong to this retained view, outside the settled callback.
      runWithOwner(viewOwner, () => runtime.start());
    }
    runtime.invalidate();
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
    // Persistence/scroll bookkeeping samples state; it is not a render dependency.
    untrack(() => runtime.chatState.prepareRender());
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
    const parentSession = projectOwner(runtime.parentSession, (owner) => owner.read(), Object.is);
    const repository = createMemo(() => {
      const target = runtime.repository.target;
      return target
        ? projectOwner(target.store, (owner) => owner.get(target.key), Object.is)
        : undefined;
    });
    const publication = createMemo(() => {
      const binding = runtime.publication.binding;
      return binding ? projectOwner(binding, (owner) => owner.view()) : undefined;
    });
    const presence = projectOwner(runtime.presence, (owner) => owner.snapshot);
    const gateway = projectGateway(context.gateway);
    const theme = projectTheme(context.theme);
    // Startup attaches one host for this mounted pane's lifetime.
    const state = runtime.readState();
    const workspace = state && projectOwner(sessionWorkspaceForHost(state), (owner) => owner.state);
    const composerCapabilities = projectOwner(runtime.composerCapabilities, (owner) => owner);
    const realtimeOwner = createMemo(() => {
      revision();
      return runtime.realtimeTalk;
    });
    const realtime = createMemo(() => {
      const owner = realtimeOwner();
      return owner && projectOwner(owner, (source) => source.snapshot);
    });
    const projects = projectOwner(projectsForGateway(context.gateway), (owner) => owner.snapshot);
    const goals = state && projectOwner(chatGoalOperations(state), (owner) => owner);
    const resources = projectOwner(runtime.activeSessionResources, (owner) => owner);
    const discussion = projectOwner(runtime.sessionDiscussion, (owner) => owner.snapshot);
    const transcript = projectOwner(runtime.transcript, (owner) => owner);
    const companion = projectOwner(runtime.sessionCompanionThreads, (owner) => owner);
    const swarm = createMemo(() => {
      const hydrator = runtime.swarm.hydrator;
      return hydrator ? projectOwner(hydrator, (owner) => owner) : undefined;
    });
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
      runtime.context.placementStartup,
      nativeGatewaysCapability(),
      lazySidebarElements,
    ].map((source) => source && projectOwner(source, (capability) => capability));
    onSettled(() => installChatComposerPickerDismissal(runtime.element.ownerDocument));
    // Relative labels tick only while this retained pane is presented.
    const minutePoll = useVisiblePoll(60_000, () => runtime.invalidate());
    const lifecycle = createSolidRenderLifecycle({
      host: runtime.element,
      presented: () => presented() && document.visibilityState !== "hidden",
      read: () => {
        revision();
        publication()?.read();
        repository()?.read();
        parentSession.read();
        presence.read();
        progress.read();
        composerCapabilities.read();
        realtime()?.read();
        projects.read();
        theme.preferences.read();
        workspace?.read();
        goals?.read();
        resources.read();
        discussion.read();
        transcript.read();
        companion.read();
        swarm()?.read();
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
      readState: () => runtime.readState(),
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
