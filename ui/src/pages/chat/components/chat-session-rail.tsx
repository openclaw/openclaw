import "../../../styles/chat/session-rail.css";
import "./chat-comment-controller.ts";
import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js";
import type { SessionObserverDigest } from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { ControlUiSessionPullRequest } from "../../../../../src/gateway/control-ui-contract.js";
import type { ChatSendShortcut } from "../../../app/settings.ts";
import { handleMarkdownCodeBlockClick } from "../../../components/markdown-code-blocks.ts";
import { markdownBlocksRef } from "../../../components/markdown-element-refs-solid.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelEmptyState } from "../../../components/solid/panel-empty-state.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { formatTimeMs } from "../../../lib/format.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import type {
  ChatSessionCompanionThread,
  ChatSessionCompanionTurn,
} from "../chat-session-companion.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { createChatAttachmentDropHandlers } from "./chat-attachments.ts";
import { MessageMarkdown } from "./chat-message-text-view.tsx";
import { SessionRailComposer, sessionRailQuestion } from "./chat-session-rail-composer.tsx";

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
const SESSION_RAIL_STARTER_KEYS = ["changed", "stopped", "remaining"] as const;
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

export type ChatSessionRailProps = {
  sessionKey: string;
  digest: SessionObserverDigest | null;
  running: boolean;
  activeRunId: string | null;
  pullRequests: ControlUiSessionPullRequest[];
  companion: ChatSessionCompanionThread;
  connected: boolean;
  sendShortcut: ChatSendShortcut;
  onSubmit?: (question: string | ChatSessionCompanionTurn) => void;
  onDraftChange?: (draft: string) => void;
  onAttachmentsChange?: ChatAttachmentControlsProps["onAttachmentsChange"];
  attachmentLimits?: ChatAttachmentControlsProps["attachmentLimits"];
  uploadConfig?: ChatAttachmentControlsProps["uploadConfig"];
  presented: boolean;
  focusRequest?: () => boolean;
};
export type ChatSessionRailElement = SolidBridgeElement<ChatSessionRailProps>;

export function ChatSessionRailContent(props: ChatSessionRailProps) {
  let region!: HTMLElement;
  let thread!: HTMLDivElement;
  const blocks = markdownBlocksRef(() => props.presented);
  const [configRevision, setConfigRevision] = createSignal(0);
  createEffect(
    () => props.uploadConfig,
    (config) => config?.subscribe(() => setConfigRevision((value) => value + 1)),
  );
  // The synchronous companion owner mutates settled turns in place. Snapshot its published fields.
  const turns = createMemo(() => props.companion.turns.map((turn) => ({ ...turn, source: turn })));
  const pending = () => props.companion.turns.some((turn) => turn.status === "pending");
  const attachmentProps = createMemo<ChatAttachmentControlsProps>(() => {
    configRevision();
    const companion = props.companion;
    const reads = companion.attachmentReads;
    const readSignal = reads?.readSignal;
    return {
      uploadConfig: props.uploadConfig,
      attachments: companion.attachments,
      getAttachments: () => companion.attachments ?? [],
      attachmentReads: reads,
      readSignal,
      attachmentLimits: props.attachmentLimits,
      selectionContextOnly: true,
      imagesOnly: true,
      disabled: !props.connected,
      onAttachmentsChange: props.onAttachmentsChange,
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
  // The pane consumes its focus intent only when it publishes a new request.
  const focusRequest = createMemo(() => props.focusRequest);
  createEffect(focusRequest, (request) => {
    const requested = request?.();
    if (untrack(() => props.presented) && requested) {
      region
        .querySelector<HTMLTextAreaElement>(".chat-session-rail__input:not(:disabled)")
        ?.focus({ preventScroll: true });
    }
  });
  const scrollKey = createMemo(() =>
    JSON.stringify(props.companion.turns.map((turn) => [turn.question, turn.status])),
  );
  createEffect(scrollKey, () => {
    thread.scrollTop = thread.scrollHeight;
  });
  const showPullRequests = () =>
    props.digest &&
    (!props.running || (props.activeRunId && props.digest.runId === props.activeRunId));
  return (
    <section
      ref={(element) => {
        region = element;
      }}
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
            icon={<Icon name="bot" />}
            heading={t("chat.sidePanel.companion")}
            description={t("chat.rail.empty")}
          />
        )}
        <For each={turns()} keyed={false}>
          {(turn) => {
            const answered = createMemo(() => {
              const value = turn();
              return value.status === "answered" ? value : undefined;
            });
            const failed = createMemo(() => {
              const value = turn();
              return value.status === "failed" ? value : undefined;
            });
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
                <div class="chat-group user chat-session-rail__message">
                  <div class="chat-bubble chat-session-rail__question">
                    <MessageMarkdown
                      markdown={turn().question}
                      messageKey={turn().question}
                      options={{ role: "user", isStreaming: false }}
                      markdownOptions={{ codeBlockChrome: "none", codeBlockInteraction: "static" }}
                    />
                  </div>
                </div>
                <Show
                  when={answered()}
                  fallback={
                    <>
                      <div class="chat-session-rail__hint">
                        {t(failed() ? COMPANION_HINT_KEYS[failed()!.hint] : "chat.rail.askPending")}
                      </div>
                      <Show when={failed()}>
                        {(failure) =>
                          failure().retryable &&
                          props.connected &&
                          props.onSubmit && (
                            <button
                              class="btn btn--secondary chat-session-rail__retry"
                              type="button"
                              disabled={pending()}
                              onClick={() => props.onSubmit?.(failure().source)}
                            >
                              {t("chat.rail.askRetry")}
                            </button>
                          )
                        }
                      </Show>
                    </>
                  }
                >
                  {(answer) => (
                    <>
                      <div class="chat-group assistant chat-session-rail__message">
                        <div class="chat-bubble chat-session-rail__answer">
                          <MessageMarkdown
                            markdown={answer().answer}
                            messageKey={String(answer().ts)}
                            options={{ role: "assistant", isStreaming: false }}
                            markdownOptions={{ codeBlockInteraction: "interactive" }}
                          />
                        </div>
                      </div>
                      <time
                        class="chat-session-rail__timestamp"
                        datetime={new Date(answer().ts).toISOString()}
                      >
                        {t("chat.rail.asOf", {
                          time: formatTimeMs(
                            answer().ts,
                            { hour: "numeric", minute: "2-digit" },
                            "",
                          ),
                        })}
                      </time>
                    </>
                  )}
                </Show>
              </article>
            );
          }}
        </For>
      </div>
      {!props.companion.turns.some((turn) => turn.status !== "failed") && (
        <div class="chat-session-rail__starters">
          <For each={SESSION_RAIL_STARTER_KEYS}>
            {(key) => (
              <button
                class="chip chat-session-rail__starter"
                type="button"
                disabled={!props.connected}
                onClick={() => props.onSubmit?.(t(`chat.rail.starters.${key}`))}
              >
                <Icon name="spark" />
                <span>{t(`chat.rail.starters.${key}`)}</span>
              </button>
            )}
          </For>
        </div>
      )}
      <openclaw-chat-comment-controller
        prop:paneId={`side-chat:${props.sessionKey}`}
        prop:props={attachmentProps()}
        prop:disabled={attachmentProps().disabled}
        prop:sessionKey={props.sessionKey}
        prop:presented={props.presented}
      />
      <SessionRailComposer
        companion={props.companion}
        connected={props.connected}
        pending={pending()}
        sendShortcut={props.sendShortcut}
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
    properties: {
      sessionKey: { default: "", attribute: false },
      digest: { default: null, attribute: false },
      running: { default: false, attribute: false },
      activeRunId: { default: null, attribute: false },
      pullRequests: { default: [], attribute: false },
      companion: { default: { turns: [], loading: false, draft: "" }, attribute: false },
      connected: { default: false, attribute: false },
      sendShortcut: { default: "enter", attribute: false },
      onSubmit: { default: undefined, attribute: false },
      onDraftChange: { default: undefined, attribute: false },
      onAttachmentsChange: { default: undefined, attribute: false },
      attachmentLimits: { default: undefined, attribute: false },
      uploadConfig: { default: undefined, attribute: false },
      presented: { default: false, type: Boolean },
      focusRequest: { default: undefined, attribute: false },
    },
  },
);

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-comment-controller": HTMLAttributes<HTMLElement> & {
        "prop:paneId": string;
        "prop:props": ChatAttachmentControlsProps;
        "prop:disabled"?: boolean;
        "prop:sessionKey": string;
        "prop:presented": boolean;
      };
    }
  }
}
