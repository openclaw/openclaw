import type { Component } from "solid-js";
import { createEffect, createMemo, createSignal, Show, untrack } from "solid-js";
import type { ControlUiSurfaceProps } from "../../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { ExecApprovalCard } from "../../components/exec-approval-card-solid.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../../lib/keyboard-shortcut-contract.ts";
import { ApplicationProvider, useOptionalApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { scopedSessionArtifactKey } from "../../lib/sessions/session-key.ts";
import { PRESENTATION_CHANGED_EVENT } from "../../lit/presentation-binding.ts";
import { LitContent, solidContent, emptyLegacyContent } from "../../lit/solid-content.tsx";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { loadChatPendingInputs } from "./chat-pending-inputs.ts";
import { forwardChatWheelToTranscript } from "./chat-scroll-input.ts";
import { createChatViewFrame, type ChatProps, type ChatViewFrame } from "./chat-view-frame.ts";
import {
  renderChatComposerNotices as ChatComposerNoticesView,
  renderChatTopbarNotices as ChatTopbarNotices,
} from "./chat-view-notices.tsx";
import { ChatCommentController } from "./components/chat-comment-controller.ts";
import {
  ComposerQuestionDock,
  resolveComposerQuestionPanel,
} from "./components/chat-composer-question.tsx";
import { ComposerQueue } from "./components/chat-composer-regions.tsx";
import { getChatComposerState, hasTerminalRunStatus } from "./components/chat-composer-state.ts";
import { ChatComposer } from "./components/chat-composer.tsx";
import { isImageLightboxEvent, openInlineChatImage } from "./components/chat-image-lightbox.ts";
import { ChatPullRequests } from "./components/chat-pull-requests.tsx";
import { renderChatSelectionAnnotations } from "./components/chat-selection-annotations.ts";
import { renderChatSessionSuggestions } from "./components/chat-session-suggestions.ts";
import { renderChatSwarmProgress } from "./components/chat-swarm-progress.ts";
import { ChatTaskSuggestionTray } from "./components/chat-task-suggestions.tsx";
import {
  renderTranscriptSearch,
  toggleTranscriptSearch,
} from "./components/chat-thread-interactions.ts";
import { ChatThread } from "./components/chat-thread-view.tsx";
import "../../components/resizable-divider.ts";
export type { ChatProps } from "./chat-view-frame.ts";

type ChatViewInput = {
  props: ChatProps;
  frame: ChatViewFrame;
  presented: boolean;
  application?: ApplicationContext;
};

function ChatTranscript(input: ChatViewInput) {
  return <ChatThread props={input.frame.threadProps} transcript={input.props.transcript} />;
}

function ChatFooterContent(input: ChatViewInput) {
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
    <>
      <Show
        when={
          pendingInputs() &&
          (pendingInputs()?.error ||
            pendingInputs()?.page.nextBefore !== undefined ||
            pendingInputs()?.before !== undefined)
        }
      >
        <div class="chat-pending-inputs" role="status">
          <Show when={pendingInputs()?.error}>
            <span>{pendingInputs()?.error}</span>
          </Show>
          <Show when={pendingInputs()?.page.nextBefore !== undefined}>
            {pendingButton("earlier")}
          </Show>
          <Show when={pendingInputs()?.before !== undefined}>{pendingButton("latest")}</Show>
        </div>
      </Show>
      <Show when={input.props.inlineApproval && input.props.onApprovalDecision}>
        <div class="chat-inline-approval">
          <ExecApprovalCard
            props={{
              approval: input.props.inlineApproval!,
              sourceSession: input.frame.approvalSourceSession,
              busy: input.props.approvalBusy === true,
              canGrant: input.props.approvalCanGrant,
              error: input.props.approvalErrors?.get(input.props.inlineApproval!.id) ?? null,
              variant: "inline",
              onDecision: input.props.onApprovalDecision!,
            }}
          />
        </div>
      </Show>
      <Show when={!input.props.detailsEnabled}>
        <ChatPullRequests
          pullRequests={input.props.pullRequests ?? []}
          gateway={input.props.pullRequestsGateway}
          sessionId={input.props.pullRequestsSessionId}
          sessionKey={scopedSessionArtifactKey(
            input.props.sessionKey,
            input.props.currentAgentId ?? undefined,
          )}
          presented={input.props.presented ?? true}
          branch={input.props.pullRequestsBranch}
          branchDismissed={input.props.pullRequestsBranchDismissed}
          status={input.props.pullRequestsStatus ?? "ready"}
          onDismiss={(pullRequest) => input.props.onDismissPullRequest?.(pullRequest)}
          onDismissBranch={input.props.onDismissPullRequestsBranch}
          onOpenSessionDiff={input.props.onOpenSessionDiff}
          publication={input.props.githubPublication}
        />
      </Show>
      <LitContent
        value={renderChatSessionSuggestions({
          suggestions: input.props.sessionSuggestions ?? [],
          role: input.props.sessionSuggestionRole,
          busyIds: input.props.sessionSuggestionBusyIds ?? new Set(),
          archived: input.props.sessionSuggestionsArchived === true,
          canResolve: input.props.canResolveSessionSuggestions === true,
          onResolve: (suggestion, resolution) =>
            input.props.onResolveSessionSuggestion?.(suggestion, resolution),
        })}
      />
      <Show when={input.props.swarm}>
        <LitContent value={renderChatSwarmProgress(input.props.swarm!)} />
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
  return (
    <ChatComposer
      {...input.props}
      renderRevision={input.frame}
      progressCard={input.props.detailsEnabled ? null : input.props.progressCard}
      progressCardInitialLoading={
        input.props.detailsEnabled ? false : input.props.progressCardInitialLoading
      }
      asyncQuestions={input.frame.asyncQuestions}
      displayQueue={input.frame.displayQueue}
      footerContent={<ChatFooterContent {...input} />}
      notices={<ChatComposerNoticesView {...input.props} />}
      onRequestUpdate={input.frame.requestUpdate}
      onToggleRealtimeTalk={
        input.props.suggestionComposer ? undefined : input.props.onToggleRealtimeTalk
      }
      onOpenImage={input.frame.openImmediateImage}
    />
  );
}

function ChatComposerCompanion(input: ChatViewInput) {
  return (
    <div class="chat-footer__context">
      <ChatFooterContent {...input} />
      <div class="agent-chat__composer-notices">
        <ChatComposerNoticesView {...input.props} />
      </div>
      <ComposerQuestionDock
        panel={resolveComposerQuestionPanel(
          { ...input.props, asyncQuestions: input.frame.asyncQuestions },
          getChatComposerState(input.props.paneId),
          input.frame.requestUpdate,
        )}
      />
      <ComposerQueue
        composer={{ ...input.props, displayQueue: input.frame.displayQueue }}
        showAbortableUi={
          Boolean(input.props.canAbort && input.props.onAbort) &&
          !hasTerminalRunStatus(input.props.runStatus)
        }
      />
      <Show when={!input.props.suggestionComposer}>
        <LitContent
          value={renderChatSelectionAnnotations({ ...input.props, disabled: !input.props.canSend })}
        />
      </Show>
      <LitContent value={input.props.composerRecovery ?? emptyLegacyContent} />
    </div>
  );
}

/** Plugin mountDefault creates a separate root and must carry its application scope. */
function ChatSurfaceContent(input: { view: Component<ChatViewInput>; viewProps: ChatViewInput }) {
  const View = untrack(() => input.view);
  return (
    <Show when={input.viewProps.application} keyed fallback={<View {...input.viewProps} />}>
      {(application) => (
        <ApplicationProvider value={application}>
          <View {...input.viewProps} />
        </ApplicationProvider>
      )}
    </Show>
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
}) {
  const app = useOptionalApplication();
  const runtime = projectSource(app?.plugins, {
    read: (source) => source,
    subscribe: (source, publish) => source?.subscribe(publish) ?? (() => {}),
    equality: "revision",
  });
  const selected = createMemo(() =>
    runtime.read()?.selectedReplacement(input.binding["prop:surface"]),
  );
  return (
    <Show when={selected()} fallback={<input.view {...input.viewProps} />}>
      <openclaw-plugin-view
        {...input.binding}
        prop:presented={input.viewProps.presented}
        data-plugin-composer={input.binding["prop:surface"] === "composer" ? "" : undefined}
        prop:defaultView={solidContent(ChatSurfaceContent, {
          view: input.view,
          viewProps: input.viewProps,
        })}
        prop:replacementCompanion={
          input.companion
            ? solidContent(ChatSurfaceContent, {
                view: input.companion,
                viewProps: input.viewProps,
              })
            : undefined
        }
      />
    </Show>
  );
}

export function ChatView(input: { props: ChatProps; application?: ApplicationContext }) {
  return (
    <Show when={input.application} keyed fallback={<ChatContent props={input.props} />}>
      {(application) => (
        <ApplicationProvider value={application}>
          <ChatContent props={input.props} />
        </ApplicationProvider>
      )}
    </Show>
  );
}

function ChatContent(input: { props: ChatProps }) {
  const application = useOptionalApplication();
  const frame = createMemo(() => createChatViewFrame(input.props));
  const [presentationRevision, setPresentationRevision] = createSignal(0, { ownedWrite: true });
  createEffect(
    () => input.props.presented,
    (binding) => {
      if (typeof binding !== "object") {
        return undefined;
      }
      const notify = () => setPresentationRevision((value) => value + 1);
      binding.owner.addEventListener(PRESENTATION_CHANGED_EVENT, notify);
      return () => binding.owner.removeEventListener(PRESENTATION_CHANGED_EVENT, notify);
    },
  );
  const presented = () => {
    presentationRevision();
    const binding = input.props.presented;
    return typeof binding === "object" ? binding.isPresented() : (binding ?? true);
  };
  const viewProps = () => ({
    props: input.props,
    frame: frame(),
    presented: presented(),
    application,
  });
  const historyMessage = () => {
    const state = frame().historyLoadState;
    return state?.phase === "failed" ? state.message : "";
  };
  const historyFailure = (inline: boolean) => (
    <div
      class={["chat-history-error", { "chat-history-error--inline": inline }]}
      role={inline ? "status" : "alert"}
    >
      <span>{historyMessage()}</span>
      <button
        class="btn btn--sm"
        type="button"
        onClick={() => {
          const state = input.props.historyState;
          if (state && getChatHistoryLoadState(state).phase === "failed") {
            input.props.onRefresh();
            state.requestUpdate?.();
          }
        }}
      >
        {t("common.retry")}
      </button>
    </div>
  );
  return (
    <section
      class={["chat", { "chat--bubbles": input.props.chatBubbleMode }]}
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
          toggleTranscriptSearch(input.props.paneId, frame().requestUpdate, event);
        }
      }}
    >
      <Show when={!input.props.suggestionComposer}>
        <ChatCommentController
          paneId={input.props.paneId}
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
                <LitContent
                  value={renderTranscriptSearch(input.props.paneId, frame().requestUpdate)}
                />
                <div class="chat-main__conversation-frame">
                  <div
                    class="chat-main__conversation"
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
                        <ChatTaskSuggestionTray view={input.props} />
                      </div>
                    </Show>
                    <div class="chat-footer">
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
