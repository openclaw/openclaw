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
import { createDeferredCore, type Deferred } from "../../../../src/shared/deferred.ts";
import { chatInputOwnerForContext } from "../../app/chat-input-owner.ts";
import {
  availableLinkReaders,
  availableLinkPreviewReaders,
} from "../../app/link-reader-routing.ts";
import { nativeGatewaysCapability } from "../../app/native-gateways.runtime.ts";
import { isChatControlCommand } from "../../lib/chat/commands.ts";
import { projectsForGateway } from "../../lib/projects.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { projectProgressCard } from "../../lib/reactive/domain-keyed.ts";
import { i18nRevision } from "../../lib/reactive/i18n.ts";
import { createParkedProjection } from "../../lib/reactive/parked-projection.ts";
import { projectOwner, projectSource } from "../../lib/reactive/projection.ts";
import { projectTheme } from "../../lib/reactive/theme.ts";
import { useVisiblePoll } from "../../lib/reactive/visible-poll.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { ChatComposerCapabilityDialogs } from "./chat-composer-capability-host.tsx";
import { projectChatFields } from "./chat-field-projection.ts";
import { chatGoalOperations } from "./chat-goals.ts";
import { chatPanePropertyKeys } from "./chat-pane-inputs.ts";
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
import { activeQueuedMessageEdit, subscribeQueuedMessageEdit } from "./queued-message-edit.ts";
import { notifyRenderLifecycleForTest } from "./render-lifecycle.ts";

/** One Solid owner publishes, mounts, and retires the synchronous pane runtime. */
export function createChatPaneView(runtime: ChatPaneRuntime) {
  const viewOwner = getOwner();
  for (const owner of [
    runtime.tasks,
    runtime.publication,
    runtime.repository,
    runtime.headerPresentation,
    runtime.collaboration,
    runtime.companionIntents,
    runtime.presentation,
    runtime.resetConfirmation,
    runtime.progressVisibility,
    runtime.dashboardPresentation,
    runtime.sessionCreation,
    runtime.swarm,
    runtime.boardPresentation,
    runtime.pendingPanelToggles,
    runtime.workspaceConflicts,
  ]) {
    projectChatFields(owner);
  }
  projectChatFields(runtime, [
    ...chatPanePropertyKeys,
    "paneWidth",
    "desktopFocus",
    "replyNavigationSessionKey",
    "replyNavigationId",
  ]);
  const [ready, setReady] = createSignal(false);
  let disposed = false;
  let pendingCommit: Deferred<boolean> | undefined;
  let previousFocusComposer: boolean | undefined;
  let focusPending = false;

  function waitForCommit(): Promise<boolean> {
    return (pendingCommit ??= createDeferredCore<boolean>()).promise;
  }

  Object.defineProperty(runtime, "updateComplete", {
    configurable: true,
    get: () =>
      new Promise<boolean>((resolve) => {
        // Bridge property effects enter the frame before this settled-DOM observation.
        queueMicrotask(() => onSettled(() => resolve(pendingCommit?.promise ?? true)));
      }),
  });
  runtime.awaitDomCommit = () => {
    const promise = waitForCommit();
    queueMicrotask(() =>
      onSettled(() => {
        // Explicit DOM tasks may need no new frame. Parked tasks wait for reveal or disposal.
        if (
          pendingCommit?.promise === promise &&
          (disposed || (runtime.presented && runtime.presentation.documentVisible))
        ) {
          const finish = pendingCommit;
          pendingCommit = undefined;
          finish.resolve(true);
        }
      }),
    );
    return promise;
  };

  onSettled(() => {
    if (!runtime.isConnected) {
      // Startup creates projections that belong to this retained view, outside the settled callback.
      runWithOwner(viewOwner, () => runtime.start());
    }
    setReady(true);
  });
  onCleanup(() => {
    disposed = true;
    runtime.dispose();
    pendingCommit?.resolve(true);
    pendingCommit = undefined;
  });

  function prepareRender() {
    void waitForCommit();
    focusPending ||= runtime.focusComposer !== previousFocusComposer;
    previousFocusComposer = runtime.focusComposer;
    // Persistence/scroll bookkeeping samples state; it is not a render dependency.
    untrack(() => runtime.chatState.prepareRender());
    // Target/activation checks make reconciliation idempotent; apply layout before sampling it.
    runtime.synchronizeInputs({});
  }
  function commitRender() {
    const finish = pendingCommit;
    pendingCommit = undefined;
    const focus = focusPending;
    focusPending = false;
    runtime.afterRender(focus);
    runtime.chatState.commitRender();
    if (runtime.presented && runtime.presentation.documentVisible) {
      notifyRenderLifecycleForTest(runtime.element, "commit");
    }
    finish?.resolve(true);
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
    const gateway = projectGateway(context.gateway);
    const theme = projectTheme(context.theme);
    // Startup attaches one host for this mounted pane's lifetime.
    const state = runtime.readState();
    const realtime = createMemo(() => {
      const owner = runtime.realtimeTalk;
      return owner && projectOwner(owner, (source) => source.snapshot);
    });
    // Ordinary keystrokes stay in the composer; command intent changes the pane's submit gate.
    const controlCommand = projectOwner(
      runtime.chatState.composerDraft,
      (source) => isChatControlCommand(source.read().draft),
      Object.is,
    );
    const attachments = projectOwner(
      runtime.chatState.composerDraft,
      (source) => source.read().attachments,
      Object.is,
    );
    const projects = projectOwner(projectsForGateway(context.gateway), (owner) => owner.snapshot);
    const queuedEdit =
      state &&
      projectSource(state, {
        read: activeQueuedMessageEdit,
        subscribe: subscribeQueuedMessageEdit,
        equality: "revision",
      });
    const swarm = createMemo(() => {
      const hydrator = runtime.swarm.hydrator;
      return hydrator ? projectOwner(hydrator, (owner) => owner) : undefined;
    });
    const board = createMemo(() => {
      const provider = runtime.boardPresentation.provider;
      return provider
        ? [
            projectOwner(provider.snapshot$, (source) => source.value),
            projectOwner(provider.loadError$, (source) => source.value),
          ]
        : [];
    });
    runtime.mountPanelActions();
    runtime.mountToolIcons(() => gateway.read().snapshot);
    const progressScope = createMemo(
      () => {
        gateway.read();
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
      context.plugins,
      context.agents,
      context.config,
      context.overlays,
      context.navigation,
      context.placementStartup,
      context.runtimeConfig,
      runtime.presence,
      state && sessionWorkspaceForHost(state),
      chatInputOwnerForContext(context),
      runtime.sessionDiscussion,
      runtime.composerCapabilities,
      runtime.questionPromptState,
      state && chatGoalOperations(state),
      runtime.activeSessionResources,
      runtime.transcript,
      runtime.sessionCompanionThreads,
      nativeGatewaysCapability(),
      lazySidebarElements,
    ].map((source) => source && projectOwner(source, (capability) => capability));
    onSettled(() => installChatComposerPickerDismissal(runtime.element.ownerDocument));
    // Relative labels tick only while this retained pane is presented.
    const [relativeTime, setRelativeTime] = createSignal(Date.now());
    const minutePoll = useVisiblePoll(60_000, () => setRelativeTime(Date.now()));
    const frame = createParkedProjection(
      () => {
        relativeTime();
        publication()?.read();
        repository()?.read();
        parentSession.read();
        progress.read();
        realtime()?.read();
        projects.read();
        theme.preferences.read();
        controlCommand.read();
        attachments.read();
        queuedEdit?.read();
        swarm()?.read();
        board().forEach((source) => source.read());
        i18nRevision();
        sources.forEach((source) => source?.read());
        prepareRender();
        return runtime.render(() => providerReview);
      },
      () => runtime.presented && runtime.presentation.documentVisible,
    );
    const providerReview: ChatProviderReviewOwner = createChatProviderReview({
      source: () => frame().providerReviewSource,
      readState: () => runtime.readState(),
    });
    // Commit transcript geometry and control the browser timer after Solid publishes the frame.
    createEffect(
      () => ({ frame: frame(), presented: runtime.presented }),
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
        prop:agentId={runtime.agentId ?? parseAgentSessionKey(runtime.sessionKey)?.agentId}
        prop:sessionKey={runtime.sessionKey}
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
