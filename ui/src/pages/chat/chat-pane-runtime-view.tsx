import {
  createEffect,
  createMemo,
  createSignal,
  Errored,
  lazy,
  Loading,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";
import { createDeferredCore, type Deferred } from "../../../../src/shared/deferred.ts";
import { chatInputOwnerForContext } from "../../app/chat-input-owner.ts";
import {
  availableLinkReaders,
  availableLinkPreviewReaders,
} from "../../app/link-reader-routing.ts";
import { nativeGatewaysCapability } from "../../app/native-gateways.runtime.ts";
import { isChatControlCommand } from "../../lib/chat/commands.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { projectProgressCard } from "../../lib/reactive/domain-keyed.ts";
import { i18nRevision, t } from "../../lib/reactive/i18n.ts";
import { createParkedProjection } from "../../lib/reactive/parked-projection.ts";
import { projectOwner, projectSource } from "../../lib/reactive/projection.ts";
import { projectTheme } from "../../lib/reactive/theme.ts";
import { useVisiblePoll } from "../../lib/reactive/visible-poll.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { projectChatFields } from "./chat-field-projection.ts";
import { chatGoalOperations } from "./chat-goals.ts";
import { adoptBootComposer } from "./chat-pane-boot-composer.ts";
import { chatPanePropertyKeys } from "./chat-pane-inputs.ts";
import { PaneLayout } from "./chat-pane-layout-view.tsx";
import type { ChatPaneRuntime } from "./chat-pane-render.ts";
import type { ChatProviderReviewOwner } from "./chat-provider-review-controller.tsx";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { createComposerQuestions } from "./components/chat-composer-questions.ts";
import { ChatLazyBoundary } from "./components/chat-lazy-boundary.tsx";
import { installChatComposerPickerDismissal } from "./components/chat-picker-overlay.ts";
import { sessionWorkspaceForHost } from "./components/chat-session-workspace-state.ts";
import { activeQueuedMessageEdit, subscribeQueuedMessageEdit } from "./queued-message-edit.ts";
import { notifyRenderLifecycleForTest } from "./render-lifecycle.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";
import { waitForPrewarmedChatSnapshot } from "./session-snapshot-store.ts";

const ChatComposerCapabilityDialogs = lazy(() => import("./chat-composer-capability-host.tsx"), {
  export: "ChatComposerCapabilityDialogs",
});

const ChatProviderReviewHost = lazy(() => import("./chat-provider-review-controller.tsx"), {
  export: "ChatProviderReviewHost",
});

/** One Solid owner publishes, mounts, and retires the synchronous pane runtime. */
export function createChatPaneView(runtime: ChatPaneRuntime) {
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
    runtime.mobilePresentation,
  ]) {
    projectChatFields(owner);
  }
  projectChatFields(runtime, [
    ...chatPanePropertyKeys,
    "composerCapabilities",
    "paneWidth",
    "desktopFocus",
    "deferredSessionHydration",
    "dashboardControls",
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
    const gateway = runtime.context.gateway;
    const pendingSnapshot = waitForPrewarmedChatSnapshot(
      resolveChatSnapshotKey(
        {
          settings: gateway.connection,
          client: gateway.snapshot.client,
          hello: gateway.snapshot.hello,
          agentsList: runtime.context.agents.state.agentsList,
        },
        { sessionKey: runtime.sessionKey },
      ),
    );
    if (pendingSnapshot) {
      void pendingSnapshot.then(() => {
        if (!disposed) {
          setReady(true);
        }
      });
    } else {
      setReady(true);
    }
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
    // Other source frames may show a buffered stream before its normal RAF publishes it.
    runtime.chatState.captureRenderChanges();
    // Target/activation checks make reconciliation idempotent; apply layout before sampling it.
    runtime.synchronizeInputs({});
  }
  function commitRender() {
    const finish = pendingCommit;
    pendingCommit = undefined;
    const focus = focusPending;
    focusPending = false;
    runtime.afterRender(focus);
    adoptBootComposer(runtime);
    runtime.chatState.commitRender();
    if (runtime.presented && runtime.presentation.documentVisible) {
      notifyRenderLifecycleForTest(runtime.element, "commit");
    }
    finish?.resolve(true);
  }

  function MountedPane() {
    if (!runtime.isConnected) {
      // The ready gate defers connection until settlement; its projections belong to this view.
      runtime.start();
    }
    const context = runtime.context;
    // The pane retains mobile presentation while its optional host is absent.
    onSettled(() => runtime.observeMobileViewport());
    const parentSession = projectOwner(runtime.parentSession, (owner) => owner.read(), Object.is);
    const transcriptPosition = projectOwner(
      runtime.transcript,
      (owner) => owner.isPositionSettled,
      Object.is,
    );
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
    const state = runtime.state;
    const realtime = createMemo(() => {
      const owner = runtime.state?.realtimeTalk;
      return (
        owner && {
          view: projectOwner(
            owner,
            (source) => source.snapshot,
            (previous, next) =>
              Object.entries(previous).every(
                ([key, value]) =>
                  key === "realtimeTalkConversationState" ||
                  Object.is(value, Reflect.get(next, key)),
              ),
          ),
          conversation: projectOwner(
            owner,
            (source) => source.snapshot.realtimeTalkConversationState.entries,
            Object.is,
          ),
        }
      );
    });
    const readRealtimeTalkConversation = () => realtime()?.conversation.read() ?? [];
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
    const progress = projectProgressCard(progressScope);
    const cacheProgress = () => {
      const { target, store, options } = runtime.readProgressCardScope();
      if (target && options.admitAutomaticRead()) {
        runtime.cacheProgressCard(target, store.get(target));
      }
    };
    onSettled(() => {
      // Parking may stop rendering, but reset/delete events must still retire card lifetimes.
      const stop = progress.subscribe(cacheProgress);
      cacheProgress();
      return stop;
    });
    const composerCapabilities = createMemo(() => {
      const owner = runtime.composerCapabilities;
      return owner && projectOwner(owner, (source) => source);
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
      runtime.questionPromptState,
      state && chatGoalOperations(state),
      runtime.activeSessionResources,
      runtime.sessionCompanionThreads,
      nativeGatewaysCapability(),
    ].map((source) => source && projectOwner(source, (capability) => capability));
    onSettled(() => installChatComposerPickerDismissal(runtime.element.ownerDocument));
    // Relative labels tick only while this retained pane is presented.
    const [relativeTime, setRelativeTime] = createSignal(Date.now());
    const minutePoll = useVisiblePoll(60_000, () => setRelativeTime(Date.now()));
    const [providerReview, setProviderReview] = createSignal<ChatProviderReviewOwner>();
    const frame = createParkedProjection(
      () => {
        relativeTime();
        gateway.read();
        publication()?.read();
        repository()?.read();
        parentSession.read();
        transcriptPosition.read();
        progress.read();
        realtime()?.view.read();
        theme.preferences.read();
        controlCommand.read();
        attachments.read();
        queuedEdit?.read();
        swarm()?.read();
        board().forEach((source) => source.read());
        i18nRevision();
        sources.forEach((source) => source?.read());
        composerCapabilities()?.read();
        prepareRender();
        return runtime.render(providerReview, readRealtimeTalkConversation);
      },
      () => runtime.presented && runtime.presentation.documentVisible,
    );
    // Keep an admitted review alive after its row clears or its dialog closes.
    const reviewVisited = createMemo<boolean>((previous) => {
      const source = frame().providerReviewSource;
      return previous || Boolean(source && selectedChatSessionRow(source.state)?.providerReview);
    });
    const questions = createComposerQuestions(
      runtime.presentationId,
      () => frame().layout?.primary.chat ?? null,
    );
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
        <PaneLayout layout={frame().layout} questions={questions} />
        <Show when={reviewVisited()}>
          <Errored
            fallback={(error, reset) => (
              <div class="callout danger" role="alert">
                {formatUiError(error())}
                <button class="btn btn--sm" type="button" onClick={reset}>
                  {t("common.retry")}
                </button>
              </div>
            )}
          >
            <Loading>
              <ChatProviderReviewHost
                source={() => frame().providerReviewSource}
                readState={() => runtime.state}
                onReady={(owner) => setProviderReview(owner)}
              />
            </Loading>
          </Errored>
        </Show>
        <Show when={frame().capabilityDialogs}>
          {(dialogs) => (
            <ChatLazyBoundary>
              <ChatComposerCapabilityDialogs {...dialogs()} />
            </ChatLazyBoundary>
          )}
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
