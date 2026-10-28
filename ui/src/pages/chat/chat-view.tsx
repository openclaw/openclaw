import { dynamic } from "@solidjs/web";
import type { Component } from "solid-js";
import { createMemo, lazy, merge, Show } from "solid-js";
import type { ControlUiSurfaceProps } from "../../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { createSkillFileHovercard } from "../../components/skill-file-hovercard.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../../lib/keyboard-shortcut-contract.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { ApplicationProvider, useOptionalApplication } from "../../lib/reactive/context.ts";
import { connectedElementRef, elementRef } from "../../lib/reactive/element-ref.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { projectPresentation } from "../../lib/reactive/presentation.ts";
import { orderSessionPullRequests } from "../../lib/session-pull-request-presentation.ts";
import { scopedSessionArtifactKey } from "../../lib/sessions/session-key.ts";
import { PluginSurface } from "../../plugins/control-ui-view.solid.tsx";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { listDismissablePendingInputs, loadChatPendingInputs } from "./chat-pending-inputs.ts";
import { hasTerminalRunStatus, isChatRunWorking } from "./chat-run-working.ts";
import { forwardChatWheelToTranscript } from "./chat-scroll-input.ts";
import { listSubagents, projectProgressCardRuntime } from "./chat-subagent-wait.ts";
import { createChatViewFrame, type ChatProps, type ChatViewFrame } from "./chat-view-frame.ts";
import {
  renderChatComposerNotices as ChatComposerNoticesView,
  renderChatTopbarNotices as ChatTopbarNotices,
} from "./chat-view-notices.tsx";
import type { ChatActivityPillsProps } from "./components/chat-activity-pills-types.ts";
import { ChatCommentController } from "./components/chat-comment-controller.ts";
import {
  ComposerQuestionDock,
  createComposerQuestionPanel,
} from "./components/chat-composer-question.tsx";
import type { ComposerQuestions } from "./components/chat-composer-questions.ts";
import { ComposerQueue } from "./components/chat-composer-regions.tsx";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import { ChatComposer } from "./components/chat-composer.tsx";
import { ChatConversationHistoryError } from "./components/chat-conversation-history-error.tsx";
import { ChatConversationMobile } from "./components/chat-conversation-presentation.ts";
import { isImageLightboxEvent, openInlineChatImage } from "./components/chat-image-lightbox.ts";
import { ChatLazyBoundary } from "./components/chat-lazy-boundary.tsx";
import { ChatPullRequests } from "./components/chat-pull-requests.tsx";
import { ChatSelectionAnnotations } from "./components/chat-selection-annotations.tsx";
import {
  getTranscriptState,
  toggleTranscriptSearch,
} from "./components/chat-thread-interactions.ts";
import "../../components/resizable-divider.ts";
import { ChatThread } from "./components/chat-thread-view.tsx";
import { TranscriptSearch } from "./components/chat-transcript-search.tsx";

registerEnglishCatalog(registerChatSessionEnglish);

export type { ChatProps } from "./chat-view-frame.ts";

const ExecApprovalCard = lazy(() => import("../../components/exec-approval-card-solid.tsx"), {
  export: "ExecApprovalCard",
});
const ChatSessionSuggestions = lazy(
  () => import("./components/chat-session-suggestions.solid.tsx"),
  {
    export: "ChatSessionSuggestions",
  },
);
const ChatTaskSuggestionTray = lazy(() => import("./components/chat-task-suggestions.tsx"), {
  export: "ChatTaskSuggestionTray",
});

type ChatViewInput = {
  questions: ComposerQuestions;
  props: ChatProps;
  frame: ChatViewFrame;
  presented: boolean;
  application?: ApplicationContext;
  bindTranscriptViewport: (element: HTMLDivElement) => () => void;
  getTranscriptElement: () => HTMLDivElement | null;
  getScrollToLatestElement: () => HTMLButtonElement | null;
};

// Must match the fixed height of .chat-pending-inputs--history.
const SAVED_INPUT_HISTORY_HEIGHT_PX = 44;

function ChatTranscript(input: ChatViewInput) {
  const savedInputNavigation = <ChatSavedInputNavigation {...input} />;
  const hasSavedInputNavigation = () =>
    input.frame.pendingInputs &&
    (input.frame.pendingInputs.page.nextBefore !== undefined ||
      input.frame.pendingInputs.before !== undefined);
  return (
    <ChatThread
      props={input.frame.threadProps}
      transcript={input.props.transcript}
      bindViewport={input.bindTranscriptViewport}
      historySupplement={
        hasSavedInputNavigation()
          ? {
              content: savedInputNavigation,
              height: SAVED_INPUT_HISTORY_HEIGHT_PX,
            }
          : undefined
      }
    />
  );
}

function ChatSavedInputNavigation(input: ChatViewInput) {
  const pendingInputs = () => input.frame.pendingInputs;
  const pendingButton = (page: "earlier" | "latest") => (
    <button
      class="btn btn--sm"
      type="button"
      disabled={pendingInputs()?.loading}
      onClick={() => {
        if (input.props.historyState) {
          void loadChatPendingInputs(
            input.props.historyState,
            page === "earlier" ? pendingInputs()?.page.nextBefore : undefined,
          );
        }
      }}
    >
      {t(`chat.pendingInputs.${page}`)}
    </button>
  );
  return (
    <div class="chat-pending-inputs chat-pending-inputs--history">
      <Show when={pendingInputs()?.page.nextBefore !== undefined}>{pendingButton("earlier")}</Show>
      <Show when={pendingInputs()?.before !== undefined}>{pendingButton("latest")}</Show>
    </div>
  );
}

function ChatFooterContent(
  input: ChatViewInput & {
    mobileComposition?: boolean;
    activities?: ChatActivityPillsProps;
  },
) {
  const pendingInputs = () => input.frame.pendingInputs;
  const dismissableInputIds = () => {
    const view = pendingInputs();
    return input.frame.dismissPendingInputs && view
      ? listDismissablePendingInputs(view).map((pending) => pending.id)
      : [];
  };
  return (
    <>
      <Show when={pendingInputs()?.error || dismissableInputIds().length}>
        <div class="chat-pending-inputs" role="status">
          <Show when={pendingInputs()?.error}>
            <span>{pendingInputs()?.error}</span>
          </Show>
          <Show when={dismissableInputIds().length}>
            <button
              class="btn btn--sm"
              type="button"
              aria-label={t("chat.pendingInputs.dismissAllLabel")}
              onClick={() => input.frame.dismissPendingInputs?.(dismissableInputIds())}
            >
              {t("chat.pendingInputs.dismissAll")}
            </button>
          </Show>
        </div>
      </Show>
      <Show
        when={
          !input.mobileComposition && input.props.inlineApproval && input.props.onApprovalDecision
        }
      >
        <div class="chat-inline-approval">
          <ChatLazyBoundary>
            <ExecApprovalCard
              props={{
                approval: input.props.inlineApproval!,
                sourceSession: input.frame.approvalSourceSession,
                nodeDisplayName: input.props.approvalNodeNames?.get(
                  input.props.inlineApproval!.request.nodeId ?? "",
                ),
                pendingCount: input.props.approvalPendingCount,
                onOpenPending: input.props.onOpenPendingApprovals,
                busy: input.props.approvalBusy === true,
                connected: input.props.connected,
                canGrant: input.props.approvalCanGrant,
                error: input.props.approvalErrors?.get(input.props.inlineApproval!.id) ?? null,
                variant: "inline",
                onDecision: input.props.onApprovalDecision!,
              }}
            />
          </ChatLazyBoundary>
        </div>
      </Show>
      <Show when={!input.props.detailsEnabled}>
        <ChatPullRequests
          pullRequests={input.activities?.pullRequests ? [] : (input.props.pullRequests ?? [])}
          gateway={input.props.pullRequestsGateway}
          sessionId={input.props.pullRequestsSessionId}
          sessionKey={scopedSessionArtifactKey(
            input.props.sessionKey,
            input.props.currentAgentId ?? undefined,
          )}
          presented={input.props.presented ?? true}
          branch={input.activities?.publication ? undefined : input.props.pullRequestsBranch}
          branchDismissed={input.props.pullRequestsBranchDismissed}
          status={input.props.pullRequestsStatus ?? "ready"}
          onDismiss={(pullRequest) => input.props.onDismissPullRequest?.(pullRequest)}
          onDismissBranch={input.props.onDismissPullRequestsBranch}
          onOpenSessionDiff={input.props.onOpenSessionDiff}
          publication={input.activities?.publication ? undefined : input.props.githubPublication}
        />
      </Show>
      <Show when={input.props.sessionSuggestions?.length}>
        <ChatLazyBoundary>
          <ChatSessionSuggestions
            suggestions={input.props.sessionSuggestions ?? []}
            role={input.props.sessionSuggestionRole}
            busyIds={input.props.sessionSuggestionBusyIds ?? new Set()}
            archived={input.props.sessionSuggestionsArchived === true}
            canResolve={input.props.canResolveSessionSuggestions === true}
            onResolve={(suggestion, resolution) =>
              input.props.onResolveSessionSuggestion?.(suggestion, resolution)
            }
          />
        </ChatLazyBoundary>
      </Show>
      <Show when={input.application}>
        <openclaw-plugin-contributions
          prop:kind="composer"
          prop:sessionKey={input.props.sessionKey}
          prop:agentId={input.props.currentAgentId}
          prop:presented={input.presented}
        />
      </Show>
    </>
  );
}

function ChatComposerView(input: ChatViewInput) {
  const activities = createMemo((): ChatActivityPillsProps | undefined => {
    if (!input.props.mobileComposer) {
      return undefined;
    }
    const destinations = input.props.mobileActivities;
    const goal = input.props.selectedSession?.goal;
    const card = input.props.progressCard;
    return {
      presented: input.presented,
      approvalPending: Boolean(input.props.inlineApproval),
      subagents: destinations?.onOpenSubagents
        ? { activities: listSubagents(input.props), onOpen: destinations.onOpenSubagents }
        : undefined,
      goal:
        goal && destinations?.goal
          ? { ...destinations.goal, value: goal, recovery: input.props.goalRecovery }
          : undefined,
      // The pane's chat projection already applies the single Show in chat preference.
      progress:
        card && destinations?.onOpenProgress
          ? {
              card,
              sessionStatus: input.props.selectedSession?.status,
              startedAt: input.props.selectedSession?.startedAt,
              endedAt: input.props.selectedSession?.endedAt,
              hasActiveRun: isChatRunWorking(input.props),
              runtime: projectProgressCardRuntime(
                input.props.selectedSession,
                input.props,
                card.updatedAt,
                input.props.connected,
              ),
              refresh: input.props.progressCardRefresh?.state,
              onOpen: destinations.onOpenProgress,
            }
          : undefined,
      pullRequests: destinations?.onOpenPullRequest
        ? {
            items: orderSessionPullRequests(input.props.pullRequests ?? []),
            status: input.props.pullRequestsStatus ?? "ready",
            onOpen: destinations.onOpenPullRequest,
          }
        : undefined,
      publication:
        input.props.githubPublication && destinations?.publication?.eligible
          ? { view: input.props.githubPublication, onOpen: destinations.publication.onOpen }
          : undefined,
    };
  });
  return (
    <ChatComposer
      {...input.props}
      questions={input.questions}
      getTranscriptElement={input.getTranscriptElement}
      getScrollToLatestElement={input.getScrollToLatestElement}
      progressCard={
        input.props.detailsEnabled || activities()?.progress ? null : input.props.progressCard
      }
      progressCardInitialLoading={
        input.props.detailsEnabled || activities()?.progress
          ? false
          : input.props.progressCardInitialLoading
      }
      displayQueue={input.frame.displayQueue}
      footerContent={
        <ChatFooterContent
          {...input}
          mobileComposition={input.props.mobileComposer}
          activities={activities()}
        />
      }
      mobileActivityPills={activities()}
      mobileApprovalContent={
        <Show
          when={
            input.props.mobileComposer &&
            input.props.inlineApproval &&
            input.props.onApprovalDecision
          }
        >
          <div class="agent-chat__mobile-approval">
            <ChatLazyBoundary>
              <ExecApprovalCard
                props={{
                  approval: input.props.inlineApproval!,
                  sourceSession: input.frame.approvalSourceSession,
                  nodeDisplayName: input.props.approvalNodeNames?.get(
                    input.props.inlineApproval!.request.nodeId ?? "",
                  ),
                  pendingCount: input.props.approvalPendingCount,
                  onOpenPending: input.props.onOpenPendingApprovals,
                  busy: input.props.approvalBusy ?? false,
                  connected: input.props.connected,
                  canGrant: input.props.approvalCanGrant,
                  error: input.props.approvalErrors?.get(input.props.inlineApproval!.id) ?? null,
                  variant: "inline",
                  presentation: "mobile",
                  onDecision: input.props.onApprovalDecision!,
                }}
              />
            </ChatLazyBoundary>
          </div>
        </Show>
      }
      notices={<ChatComposerNoticesView {...input.props} presented={input.presented} />}
      onToggleRealtimeTalk={
        input.props.suggestionComposer ? undefined : input.props.onToggleRealtimeTalk
      }
      onOpenImage={input.frame.openImmediateImage}
    />
  );
}

function ChatComposerCompanion(input: ChatViewInput) {
  const questionPanel = createComposerQuestionPanel(
    () => input.questions,
    undefined,
    () => input.getTranscriptElement,
  );
  return (
    <div class="chat-footer__context">
      <ChatFooterContent {...input} />
      <div class="agent-chat__composer-notices">
        <ChatComposerNoticesView {...input.props} presented={input.presented} />
      </div>
      <ComposerQuestionDock panel={questionPanel()} />
      <ComposerQueue
        composer={merge(input.props, { displayQueue: input.frame.displayQueue })}
        showAbortableUi={
          Boolean(input.props.canAbort && input.props.onAbort) &&
          !hasTerminalRunStatus(input.props.runStatus)
        }
      />
      <Show when={!input.props.suggestionComposer}>
        <ChatSelectionAnnotations {...input.props} disabled={!input.props.canSend} />
      </Show>
      <Show when={input.props.composerRecovery}>
        {(recovery) => {
          const Recovery = dynamic(() => recovery().component);
          return <Recovery {...recovery()} />;
        }}
      </Show>
    </div>
  );
}

/** Plugin mountDefault creates a separate root; restore application and conversation context here. */
function ChatSurfaceContent(input: { view: Component<ChatViewInput>; viewProps: ChatViewInput }) {
  const View = dynamic(() => input.view);
  const mobile = createMemo(() => input.viewProps.props.mobileComposer === true);
  return (
    <ChatConversationMobile value={mobile}>
      <Show when={input.viewProps.application} keyed fallback={<View {...input.viewProps} />}>
        {(application) => (
          <ApplicationProvider value={application}>
            <View {...input.viewProps} />
          </ApplicationProvider>
        )}
      </Show>
    </ChatConversationMobile>
  );
}

type ChatSurfaceBinding = {
  [Surface in "transcript" | "composer"]: {
    "prop:surface": Surface;
    "prop:props": ControlUiSurfaceProps[Surface];
  };
}["transcript" | "composer"];

function ChatSurface(input: {
  binding: ChatSurfaceBinding;
  viewProps: ChatViewInput;
  view: Component<ChatViewInput>;
  companion?: Component<ChatViewInput>;
  replacementRef?: (element: HTMLElement) => void | (() => void);
}) {
  return (
    <PluginSurface
      surface={input.binding["prop:surface"]}
      props={input.binding["prop:props"]}
      presented={input.viewProps.presented}
      replacementRef={input.replacementRef}
      renderDefault={() => <ChatSurfaceContent view={input.view} viewProps={input.viewProps} />}
      renderCompanion={() => (
        <Show when={input.companion} keyed>
          {(View) => <ChatSurfaceContent view={View} viewProps={input.viewProps} />}
        </Show>
      )}
    />
  );
}

export function ChatView(input: {
  props: ChatProps;
  application?: ApplicationContext;
  questions: ComposerQuestions;
}) {
  return (
    <Show
      when={input.application}
      keyed
      fallback={<ChatContent props={input.props} questions={input.questions} />}
    >
      {(application) => (
        <ApplicationProvider value={application}>
          <ChatContent props={input.props} questions={input.questions} />
        </ApplicationProvider>
      )}
    </Show>
  );
}

function ChatContent(input: { props: ChatProps; questions: ComposerQuestions }) {
  // Composer sizing needs the viewport even before the virtualizer has rows.
  const { bind: bindTranscriptViewport, read: getTranscriptElement } =
    connectedElementRef<HTMLDivElement>();
  const { bind: bindScrollToLatestButton, read: getScrollToLatestElement } =
    connectedElementRef<HTMLButtonElement>();
  const replacementComposer = connectedElementRef<HTMLElement>();
  const application = useOptionalApplication();
  const gateway = application && projectGateway(application.gateway);
  const skillFileHovercard = createSkillFileHovercard({
    get client() {
      return gateway?.read().snapshot.client ?? null;
    },
    get agentId() {
      return input.props.currentAgentId ?? undefined;
    },
    get sessionKey() {
      return input.props.sessionKey;
    },
    onOpenFile: (file, line) =>
      input.props.onOpenSidebar?.({
        kind: "file",
        ...file,
        name: "SKILL.md",
        language: "markdown",
        line,
      }),
  });
  const presentation = createMemo(() => projectPresentation(input.props.presented ?? true));
  const presented = () => presentation().read();
  const frame = createMemo(() => {
    return createChatViewFrame(
      input.props,
      (replacement) => {
        const replacementElement = replacement && replacementComposer.read();
        const target =
          replacementElement || getChatComposerState(input.props.paneId).composerTextarea;
        target?.focus({ preventScroll: true });
      },
      // This view mounts only while its pane's question source exists.
      input.questions.source()!.asyncQuestions,
    );
  });
  const viewProps = () => ({
    questions: input.questions,
    props: input.props,
    frame: frame(),
    presented: presented(),
    application,
    bindTranscriptViewport,
    getTranscriptElement,
    getScrollToLatestElement,
  });
  const historyMessage = () => {
    const state = frame().historyLoadState;
    return state?.phase === "failed" ? state.message : "";
  };
  const retryHistory = () => {
    const state = input.props.historyState;
    if (state && getChatHistoryLoadState(state).phase === "failed") {
      input.props.onRefresh();
    }
  };
  const historyFailure = (inline: boolean) => (
    <div
      class={["chat-history-error", { "chat-history-error--inline": inline }]}
      role={inline ? "status" : "alert"}
    >
      {inline ? (
        <>
          <span>{historyMessage()}</span>
          <button class="btn btn--sm" type="button" onClick={retryHistory}>
            {t("common.retry")}
          </button>
        </>
      ) : (
        <ChatConversationHistoryError message={historyMessage()} onRetry={retryHistory} />
      )}
    </div>
  );
  return (
    <section
      class={["chat", { "chat--bubbles": input.props.chatBubbleMode }]}
      // Person references resolve session-scoped people for callers without directory access.
      data-chat-session-key={input.props.sessionKey}
      style={
        input.props.chatMessageMaxWidth
          ? {
              "--chat-thread-max-width": input.props.chatMessageMaxWidth,
              "--chat-message-max-width": "100%",
            }
          : {}
      }
      onDrop={(event) => frame().attachmentDropHandlers.onDrop(event)}
      onDragEnter={(event) => frame().attachmentDropHandlers.onDragenter(event)}
      onDragLeave={(event) => frame().attachmentDropHandlers.onDragleave(event)}
      onDragOver={(event) => frame().attachmentDropHandlers.onDragover(event)}
      onClick={(event) => openInlineChatImage(event, frame().openImmediateImage)}
      onKeyDown={(event) => {
        if (isImageLightboxEvent(event)) {
          return;
        }
        if (
          (event.key === "Enter" || event.key === " ") &&
          openInlineChatImage(event, frame().openImmediateImage)
        ) {
          return;
        }
        if (
          event.key === "Escape" &&
          input.props.replyTarget &&
          !event.defaultPrevented &&
          !event.isComposing &&
          event.keyCode !== 229 &&
          !getChatComposerState(input.props.paneId).composerComposing
        ) {
          event.preventDefault();
          input.props.onClearReply?.();
          return;
        }
        if (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.transcriptSearch, event)) {
          event.preventDefault();
          toggleTranscriptSearch(input.props.paneId, event, frame().threadProps.onFocusComposer);
        }
      }}
    >
      <Show when={!input.props.suggestionComposer}>
        <ChatCommentController
          paneId={input.props.paneId}
          onFocusComposer={frame().threadProps.onFocusComposer}
          visiblePin={(id) => getTranscriptState(input.props.paneId).commentPins?.visiblePin(id)}
          resolveSourceRange={frame().resolveCommentSource}
          props={input.props}
          disabled={!input.props.canSend}
          sessionKey={input.props.sessionKey}
          presented={presented()}
        />
      </Show>
      <div class="chat-workbench">
        <div class="chat-workbench__main">
          <div class="chat-split-container">
            <div class="chat-main">
              <div class="chat-main__conversation-column">
                <Show when={!input.props.detailsEnabled}>
                  <ChatTopbarNotices {...input.props} />
                </Show>
                <Show when={application}>
                  <openclaw-plugin-contributions
                    prop:kind="header"
                    prop:sessionKey={input.props.sessionKey}
                    prop:agentId={input.props.currentAgentId}
                    prop:presented={presented()}
                  />
                </Show>
                <TranscriptSearch search={getTranscriptState(input.props.paneId).search} />
                <div
                  class="chat-main__conversation-frame"
                  ref={[elementRef(input.props.onConversationFrameRef)]}
                >
                  <div
                    class="chat-main__conversation"
                    ref={skillFileHovercard}
                    onWheel={(event) =>
                      forwardChatWheelToTranscript(event, input.props.transcript.scrollElement)
                    }
                  >
                    <Show when={frame().historyFailed && !frame().transcriptEmpty}>
                      {historyFailure(true)}
                    </Show>
                    <Show
                      when={!(frame().historyFailed && frame().transcriptEmpty)}
                      fallback={historyFailure(false)}
                    >
                      <ChatSurface
                        binding={{
                          "prop:surface": "transcript",
                          "prop:props": {
                            sessionKey: input.props.sessionKey,
                            agentId: input.props.currentAgentId,
                            messages: input.props.messages,
                            stream: input.props.stream,
                            loading: input.props.loading,
                          },
                        }}
                        viewProps={viewProps()}
                        view={ChatTranscript}
                      />
                    </Show>
                    {/* Keep the affordance mounted so showing it never changes transcript layout. */}
                    <Show when={input.props.onScrollToBottom}>
                      <div class="chat-scroll-to-bottom-wrap">
                        <button
                          class="chat-scroll-to-bottom"
                          ref={elementRef(bindScrollToLatestButton)}
                          data-visible={input.props.showNewMessages ? "true" : "false"}
                          type="button"
                          inert={!input.props.showNewMessages}
                          aria-hidden={!input.props.showNewMessages ? "true" : "false"}
                          onClick={() => input.props.onScrollToBottom?.({ smooth: true })}
                          aria-label={t("chat.actions.scrollToLatest")}
                        >
                          <Icon name="arrowDown" />
                        </button>
                      </div>
                    </Show>
                    <Show
                      when={
                        input.props.detailsEnabled || (input.props.taskSuggestions?.length ?? 0) > 0
                      }
                    >
                      <div
                        class={[
                          "chat-gutter-stack",
                          { "chat-gutter-stack--details": input.props.detailsEnabled },
                        ]}
                      >
                        <div class="chat-gutter-header" hidden={!input.props.detailsEnabled}>
                          <Show when={input.props.detailsEnabled}>
                            <ChatTopbarNotices {...input.props} />
                          </Show>
                        </div>
                        <Show when={input.props.taskSuggestions?.length}>
                          <ChatLazyBoundary>
                            <ChatTaskSuggestionTray view={input.props} />
                          </ChatLazyBoundary>
                        </Show>
                      </div>
                    </Show>
                    <div class="chat-footer" ref={[elementRef(input.props.onFooterElementRef)]}>
                      <ChatSurface
                        binding={{
                          "prop:surface": "composer",
                          "prop:props": {
                            sessionKey: input.props.sessionKey,
                            agentId: input.props.currentAgentId,
                            draft: input.props.draft,
                            canSend: input.props.canSend && !input.props.submitDisabledReason,
                            sending: input.props.sending,
                            disabledReason:
                              input.props.submitDisabledReason ?? input.props.disabledReason,
                            setDraft: input.props.onDraftChange,
                            send: async () => input.props.onSend(),
                            abort: input.props.onAbort,
                          },
                        }}
                        viewProps={viewProps()}
                        view={ChatComposerView}
                        companion={ChatComposerCompanion}
                        replacementRef={replacementComposer.bind}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
