import "../../../styles/chat/session-rail.css";
import "../../../styles/chat/working-indicator.css";
import { createMemo, For, onSettled, Show } from "solid-js";
import type { SessionObserverDigest } from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { ControlUiSessionPullRequest } from "../../../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { ChatSendShortcut } from "../../../app/settings.ts";
import { handleMarkdownCodeBlockClick } from "../../../components/markdown-code-blocks.ts";
import { markdownBlocksRef } from "../../../components/markdown-element-refs-solid.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelEmptyState } from "../../../components/solid/panel-empty-state.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import type { MessageGroup as MessageGroupData } from "../../../lib/chat/chat-types.ts";
import { cancelLayout, scheduleLayout } from "../../../lib/layout-frame.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createParkedProjection } from "../../../lib/reactive/parked-projection.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import type { SidebarPanelDefinitionParams } from "../chat-pane-embedded-types.ts";
import { usePanePresentation } from "../chat-pane-presentation.ts";
import { createSideChatModelControlProps } from "../chat-session-companion-model-controls.ts";
import type {
  ChatSessionCompanionThread,
  ChatSessionCompanionTurn,
} from "../chat-session-companion.ts";
import { resolveChatAttachmentLimits } from "./chat-attachment-admission.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { createChatAttachmentDropHandlers } from "./chat-attachments.ts";
import { ChatCommentController } from "./chat-comment-controller.ts";
import { MessageGroup } from "./chat-message-group-view.tsx";
import { StreamGroup } from "./chat-message-stream-view.tsx";
import type { ChatModelControlsProps } from "./chat-model-controls.tsx";
import { SessionRailComposer, sessionRailQuestion } from "./chat-session-rail-composer.tsx";
import type { SidebarPanelHostRegistration } from "./chat-sidebar-region-types.ts";

registerEnglishCatalog(registerChatSessionEnglish);

/** Adapt pane facts only after Side Chat's first presentation loads this module. */
export function ChatSessionRailPanel(
  props: SidebarPanelDefinitionParams & { registerPanelHost?: SidebarPanelHostRegistration },
) {
  const presented = usePanePresentation(() => props.companionPresented);
  const modelControls = createParkedProjection(
    () =>
      props.onCompanionModelSelect
        ? createSideChatModelControlProps({
            state: props.state,
            companion: props.companion,
            onSelect: (patch) => props.onCompanionModelSelect?.(patch),
          })
        : undefined,
    presented,
  );
  return (
    <ChatSessionRail
      presentation={props.presentation}
      data-sidebar-panel-host
      ref={[elementRef((element: ChatSessionRailElement) => props.registerPanelHost?.(element))]}
      presented={presented()}
      focusRequest={props.companionFocusRequest}
      sessionKey={props.state.sessionKey}
      agentId={props.agentId}
      assistantName={props.state.assistantName}
      digest={props.digest}
      running={Boolean(props.activeRunId)}
      activeRunId={props.activeRunId}
      pullRequests={props.pullRequests}
      companion={props.companion}
      modelControls={modelControls()}
      client={props.state.connected ? props.state.client : null}
      connected={props.state.connected}
      sendShortcut={props.state.settings.chatSendShortcut ?? "enter"}
      inputDeviceId={props.state.settings.realtimeTalkInputDeviceId}
      onSubmit={props.onCompanionSubmit}
      onDraftChange={props.onCompanionDraftChange}
      onAttachmentsChange={props.onCompanionAttachmentsChange}
      onOpenImage={props.state.handleOpenImage}
      uploadConfig={props.state.uploadConfig}
      attachmentLimits={resolveChatAttachmentLimits(props.state.hello?.policy)}
    />
  );
}

function checksSummary(pullRequest: ControlUiSessionPullRequest): string | null {
  const checks = pullRequest.checks;
  if (!checks) {
    return null;
  }
  if (checks.state === "passing") {
    return t("chat.rail.checksPassing", { count: String(checks.passed) });
  }
  if (checks.state === "failing") {
    return t("chat.rail.checksFailing", { count: String(checks.failed) });
  }
  return t("chat.rail.checksPending", { count: String(checks.running) });
}
const COMPANION_HINT_KEYS = {
  busy: "chat.rail.askBusy",
  "history-unavailable": "chat.rail.askHistoryUnavailable",
  missing: "chat.rail.askMissing",
  "model-unavailable": "chat.rail.askModelUnavailable",
  "image-unsupported": "chat.rail.askImageUnsupported",
  "rate-limited": "chat.rail.askRateLimited",
  unavailable: "chat.rail.askUnavailable",
} as const satisfies Record<
  Extract<ChatSessionCompanionTurn, { status: "failed" }>["hint"],
  Parameters<typeof t>[0]
>;

// Questions and answers render as main-transcript groups, so bubbles, footer
// identity, relative timestamps and message actions share one owner.
function companionGroup(
  role: "user" | "assistant",
  content: string,
  timestamp: number,
): MessageGroupData {
  const key = `side-chat:${role}:${timestamp}`;
  return {
    kind: "group",
    key,
    role,
    messages: [{ key, message: { role, content, timestamp }, hasVisibleContent: true }],
    visibleContent: "text",
    timestamp,
    isStreaming: false,
  };
}

// Side chat history records one time per exchange; local turns keep their send time.
function companionQuestionTime(turn: ChatSessionCompanionTurn): number {
  return turn.status === "answered" ? turn.ts : turn.startedAt;
}

type ChatSessionRailProps = {
  presentation?: "desktop" | "mobile";
  sessionKey: string;
  agentId?: string | null;
  assistantName?: string;
  digest: SessionObserverDigest | null;
  running: boolean;
  activeRunId: string | null;
  pullRequests: ControlUiSessionPullRequest[];
  companion: ChatSessionCompanionThread;
  modelControls?: ChatModelControlsProps;
  client: GatewayBrowserClient | null;
  connected: boolean;
  sendShortcut: ChatSendShortcut;
  inputDeviceId?: string;
  onSubmit?: (question: string | ChatSessionCompanionTurn) => void;
  onDraftChange?: (draft: string) => void;
  onAttachmentsChange?: ChatAttachmentControlsProps["onAttachmentsChange"];
  attachmentLimits?: ChatAttachmentControlsProps["attachmentLimits"];
  uploadConfig?: ChatAttachmentControlsProps["uploadConfig"];
  onOpenImage?: ChatAttachmentControlsProps["onOpenImage"];
  presented: boolean;
  focusRequest?: () => boolean;
};
export type ChatSessionRailElement = SolidBridgeElement<ChatSessionRailProps>;

const inputHandlers = new WeakMap<HTMLElement, () => void>();

function ChatSessionRailContent(props: ChatSessionRailProps, host: ChatSessionRailElement) {
  let textarea: HTMLTextAreaElement | undefined;
  let thread!: HTMLDivElement;
  const focusComposer = () => {
    if (textarea && !textarea.disabled) {
      textarea.focus({ preventScroll: true });
    }
  };
  const blocks = markdownBlocksRef(() => props.presented);
  const uploadConfig = createMemo(() => {
    const config = props.uploadConfig;
    return config && projectOwner(config, (owner) => owner);
  });
  // The synchronous companion owner mutates settled turns in place. Snapshot its published fields.
  const turns = createMemo(() => props.companion.turns.map((turn) => ({ ...turn, source: turn })));
  const pending = () => props.companion.turns.some((turn) => turn.status === "pending");
  const attachmentProps = createMemo<ChatAttachmentControlsProps>(() => {
    const companion = props.companion;
    const reads = companion.attachmentReads;
    const readSignal = reads?.readSignal;
    return {
      uploadConfig: uploadConfig()?.read(),
      attachments: companion.attachments,
      getAttachments: () => props.companion.attachments ?? [],
      attachmentReads: reads,
      readSignal,
      attachmentLimits: props.attachmentLimits,
      selectionContextOnly: true,
      imagesOnly: true,
      disabled: !props.connected,
      onAttachmentsChange: props.onAttachmentsChange,
      onOpenImage: props.onOpenImage,
      onPendingReadsChange: (delta) => {
        if (readSignal) {
          reads?.updatePending(readSignal, delta);
        }
      },
    };
  });
  const drop = createMemo(() =>
    createChatAttachmentDropHandlers({ ...attachmentProps(), canCompose: props.connected }),
  );
  const submit = () => {
    const question = sessionRailQuestion(props.companion);
    if (
      question &&
      props.connected &&
      !props.companion.attachmentReads?.pendingReads &&
      !pending()
    ) {
      props.onSubmit?.(question);
    }
  };
  onSettled(() => {
    let focusRequest: ChatSessionRailProps["focusRequest"];
    let scrollKey: string | undefined;
    const syncInputs = () => {
      const request = host.focusRequest;
      if (request !== focusRequest) {
        focusRequest = request;
        cancelLayout(host);
        if (request) {
          // The mobile panel must commit before consuming the pane's focus intent.
          scheduleLayout(host, () => () => {
            if (host.presented && request()) {
              focusComposer();
            }
          });
        }
      }
      const nextScrollKey = JSON.stringify(
        host.companion.turns.map((turn) => [turn.question, turn.status]),
      );
      if (nextScrollKey !== scrollKey) {
        scrollKey = nextScrollKey;
        scheduleLayout(thread, () => {
          const bottom =
            host.companion.loading && !host.companion.turns.length ? 0 : thread.scrollHeight;
          return () => {
            thread.scrollTop = bottom;
          };
        });
      }
    };
    inputHandlers.set(host, syncInputs);
    syncInputs();
    return () => {
      inputHandlers.delete(host);
      cancelLayout(host);
      cancelLayout(thread);
    };
  });
  const groupOptions = createMemo(() => ({
    showReasoning: false,
    showToolCalls: false,
    // Side chat is one person and one agent: identity sits in the footer, as in
    // direct main chats without an avatar gutter, and own questions stay unnamed.
    avatarPlacement: "footer" as const,
    showOwnSenderName: false,
    assistantName: props.assistantName,
    agentId: props.agentId ?? undefined,
  }));
  const showPullRequests = () =>
    props.digest &&
    (!props.running || (props.activeRunId && props.digest.runId === props.activeRunId));
  return (
    <section
      class="chat-session-rail chat-session-rail--expanded chat-session-rail--embedded"
      role="region"
      aria-label={t("chat.rail.title")}
      tabindex="-1"
      onDragEnter={(event) => drop().onDragenter(event)}
      onDragLeave={(event) => drop().onDragleave(event)}
      onDragOver={(event) => drop().onDragover(event)}
      onDrop={(event) => drop().onDrop(event)}
    >
      {showPullRequests() && props.pullRequests.length > 0 && (
        <div class="chat-session-rail__prs" aria-label={t("chat.rail.pullRequests")}>
          <For each={props.pullRequests.slice(0, 2)} keyed={(pr) => pr.url}>
            {(pullRequest) => (
              <a
                class="chat-session-rail__pr"
                href={pullRequest().url}
                target="_blank"
                rel="noopener noreferrer"
                title={pullRequest().title}
              >
                <span>#{pullRequest().number}</span>
                <span>{t(`chat.pullRequests.${pullRequest().state}`)}</span>
                {checksSummary(pullRequest()) && (
                  <span class="chat-session-rail__pr-checks">{checksSummary(pullRequest())}</span>
                )}
              </a>
            )}
          </For>
        </div>
      )}
      <div
        class="chat-session-rail__thread"
        style={{
          padding: props.companion.loading && !props.companion.turns.length ? "0" : undefined,
        }}
        aria-live="polite"
        onClick={handleMarkdownCodeBlockClick}
        ref={(element) => {
          thread = element;
          blocks(element);
        }}
      >
        {props.companion.loading && !props.companion.turns.length && (
          <PanelLoadingSkeleton variant="chat" label={t("chat.thread.loading")} />
        )}
        {!props.companion.loading && !props.companion.turns.length && (
          <PanelEmptyState
            presentation={props.presentation}
            icon={<Icon name="bot" />}
            heading={t("chat.sidePanel.companion")}
            description={t("chat.rail.empty")}
          />
        )}
        <For each={turns()} keyed={false}>
          {(turn) => {
            const answered = () => {
              const value = turn();
              return value.status === "answered" ? value : undefined;
            };
            const failed = () => {
              const value = turn();
              return value.status === "failed" ? value : undefined;
            };
            const working = () => {
              const value = turn();
              return value.status === "pending" ? value : undefined;
            };
            return (
              <article
                class={[
                  "chat-session-rail__exchange",
                  {
                    "chat-session-rail__exchange--pending": turn().status === "pending",
                    "chat-session-rail__exchange--error": turn().status === "failed",
                  },
                ]}
              >
                <MessageGroup
                  group={companionGroup("user", turn().question, companionQuestionTime(turn()))}
                  options={groupOptions()}
                />
                <Show
                  when={answered()}
                  fallback={
                    <>
                      <Show when={working()}>
                        {(waiting) => (
                          // The main transcript's working group, shown while a run has no output yet.
                          <StreamGroup
                            parts={[
                              {
                                kind: "reading-indicator",
                                key: `side-chat:${waiting().startedAt}`,
                                startedAt: waiting().startedAt,
                              },
                            ]}
                            options={{}}
                          />
                        )}
                      </Show>
                      <Show when={failed()}>
                        {(failure) => (
                          <>
                            <div class="chat-session-rail__hint">
                              {t(COMPANION_HINT_KEYS[failure().hint])}
                            </div>
                            {failure().retryable && props.connected && props.onSubmit && (
                              <button
                                class="btn btn--secondary chat-session-rail__retry"
                                type="button"
                                disabled={pending()}
                                onClick={() => props.onSubmit?.(failure().source)}
                              >
                                {t("chat.rail.askRetry")}
                              </button>
                            )}
                          </>
                        )}
                      </Show>
                    </>
                  }
                >
                  {(answer) => (
                    <MessageGroup
                      group={companionGroup("assistant", answer().answer, answer().ts)}
                      options={groupOptions()}
                    />
                  )}
                </Show>
              </article>
            );
          }}
        </For>
      </div>
      <ChatCommentController
        onFocusComposer={focusComposer}
        paneId={`side-chat:${props.sessionKey}`}
        props={attachmentProps()}
        disabled={Boolean(attachmentProps().disabled)}
        sessionKey={props.sessionKey}
        presented={props.presented}
      />
      <SessionRailComposer
        textareaRef={(element) => (textarea = element)}
        sessionKey={props.sessionKey}
        companion={props.companion}
        modelControls={props.modelControls}
        client={props.client}
        connected={props.connected}
        presented={props.presented}
        pending={pending()}
        sendShortcut={props.sendShortcut}
        inputDeviceId={props.inputDeviceId}
        attachmentProps={attachmentProps()}
        submit={submit}
        onDraftChange={props.onDraftChange}
      />
    </section>
  );
}

export const ChatSessionRail = defineSolidBridge<ChatSessionRailProps>(
  "openclaw-chat-session-rail",
  ChatSessionRailContent,
  {
    propertyChanged: (host, key) => {
      if (key === "companion" || key === "focusRequest") {
        inputHandlers.get(host)?.();
      }
    },
    properties: {
      presentation: { default: undefined, attribute: false },
      sessionKey: { default: "", attribute: false },
      agentId: { default: undefined, attribute: false },
      assistantName: { default: undefined, attribute: false },
      digest: { default: null, attribute: false },
      running: { default: false, attribute: false },
      activeRunId: { default: null, attribute: false },
      pullRequests: { default: [], attribute: false },
      companion: { default: { turns: [], loading: false, draft: "" }, attribute: false },
      modelControls: { default: undefined, attribute: false },
      client: { default: null, attribute: false },
      connected: { default: false, attribute: false },
      sendShortcut: { default: "enter", attribute: false },
      inputDeviceId: { default: undefined, attribute: false },
      onSubmit: { default: undefined, attribute: false },
      onDraftChange: { default: undefined, attribute: false },
      onAttachmentsChange: { default: undefined, attribute: false },
      onOpenImage: { default: undefined, attribute: false },
      attachmentLimits: { default: undefined, attribute: false },
      uploadConfig: { default: undefined, attribute: false },
      presented: { default: false, type: Boolean },
      focusRequest: { default: undefined, attribute: false },
    },
  },
);
