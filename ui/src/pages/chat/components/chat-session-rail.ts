import "../../../styles/chat/session-rail.css";
import "./chat-comment-controller.ts";
import { html, nothing, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import type { SessionObserverDigest } from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { ControlUiSessionPullRequest } from "../../../../../src/gateway/control-ui-contract.js";
import type { ChatSendShortcut } from "../../../app/settings.ts";
import { icons } from "../../../components/icons.ts";
import { markdownBlocks } from "../../../components/markdown-blocks.ts";
import { handleMarkdownCodeBlockClick } from "../../../components/markdown-code-blocks.ts";
import { renderPanelEmptyState } from "../../../components/panel-empty-state.ts";
import { renderPanelLoadingSkeleton } from "../../../components/panel-loading-skeleton.ts";
import { t } from "../../../i18n/index.ts";
import { formatTimeMs } from "../../../lib/format.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../../lit/subscriptions-controller.ts";
import type {
  ChatSessionCompanionThread,
  ChatSessionCompanionTurn,
} from "../chat-session-companion.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { createChatAttachmentDropHandlers } from "./chat-attachments.ts";
import { renderMessageMarkdown } from "./chat-message-text.ts";
import {
  createSessionRailComposer,
  sessionRailQuestion,
  renderSessionRailComposer,
} from "./chat-session-rail-composer.ts";

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

export class ChatSessionRailElement extends OpenClawLightDomElement {
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) digest: SessionObserverDigest | null = null;
  @property({ attribute: false }) running = false;
  @property({ attribute: false }) activeRunId: string | null = null;
  @property({ attribute: false }) pullRequests: ControlUiSessionPullRequest[] = [];
  @property({ attribute: false }) companion: ChatSessionCompanionThread = {
    turns: [],
    loading: false,
    draft: "",
  };
  @property({ attribute: false }) connected = false;
  @property({ attribute: false }) sendShortcut: ChatSendShortcut = "enter";
  @property({ attribute: false }) onSubmit?: (question: string | ChatSessionCompanionTurn) => void;
  @property({ attribute: false }) onDraftChange?: (draft: string) => void;
  @property({ attribute: false })
  onAttachmentsChange?: ChatAttachmentControlsProps["onAttachmentsChange"];
  @property({ attribute: false })
  attachmentLimits?: ChatAttachmentControlsProps["attachmentLimits"];
  @property({ attribute: false })
  uploadConfig?: ChatAttachmentControlsProps["uploadConfig"];
  @property({ type: Boolean }) presented = false;
  @property({ attribute: false }) focusRequest?: () => boolean;

  constructor() {
    super();
    new SubscriptionsController(this).watchStore(() => this.uploadConfig);
  }
  private readonly composer = createSessionRailComposer({
    submit: () => this.submit(),
    onDraftChange: (draft) => this.onDraftChange?.(draft),
    sendShortcut: () => this.sendShortcut,
  });

  override disconnectedCallback() {
    this.composer.dispose();
    super.disconnectedCallback();
  }

  override updated(changedProperties: PropertyValues<this>) {
    // The pane owns focus intent across lazy mounting and retained tab presentation.
    const focusRequested = changedProperties.has("focusRequest")
      ? this.focusRequest?.()
      : undefined;
    if (this.presented && focusRequested) {
      this.querySelector<HTMLTextAreaElement>(".chat-session-rail__input:not(:disabled)")?.focus({
        preventScroll: true,
      });
    }
  }

  private submit() {
    const question = sessionRailQuestion(this.companion);
    if (
      question &&
      this.connected &&
      !this.companion.attachmentReads?.pendingReads &&
      !this.companion.turns.some((turn) => turn.status === "pending")
    ) {
      this.onSubmit?.(question);
    }
  }

  private renderPullRequests() {
    const pullRequests = this.pullRequests.slice(0, 2);
    if (pullRequests.length === 0) {
      return nothing;
    }
    return html`
      <div class="chat-session-rail__prs" aria-label=${t("chat.rail.pullRequests")}>
        ${pullRequests.map((pullRequest) => {
          const checks = checksSummary(pullRequest);
          return html`
            <a
              class="chat-session-rail__pr"
              href=${pullRequest.url}
              target="_blank"
              rel="noopener noreferrer"
              title=${pullRequest.title}
            >
              <span>#${pullRequest.number}</span>
              <span>${t(`chat.pullRequests.${pullRequest.state}`)}</span>
              ${
                checks ? html`<span class="chat-session-rail__pr-checks">${checks}</span>` : nothing
              }
            </a>
          `;
        })}
      </div>
    `;
  }

  private renderStarters() {
    return html`
      <div class="chat-session-rail__starters">
        ${SESSION_RAIL_STARTER_KEYS.map((key) => {
          const question = t(`chat.rail.starters.${key}`);
          return html`
            <button
              class="chip chat-session-rail__starter"
              type="button"
              ?disabled=${!this.connected}
              @click=${() => this.onSubmit?.(question)}
            >
              ${icons.spark}<span>${question}</span>
            </button>
          `;
        })}
      </div>
    `;
  }

  private renderThread(pending: boolean) {
    const { turns } = this.companion;
    const scrollKey = JSON.stringify(turns.map((turn) => [turn.question, turn.status]));
    const syncScroll = (element: Element | undefined) => {
      if (!(element instanceof HTMLElement) || element.dataset.railScrollKey === scrollKey) {
        return;
      }
      element.dataset.railScrollKey = scrollKey;
      element.scrollTop = element.scrollHeight;
    };
    return html`
      <div
        class="chat-session-rail__thread"
        aria-live="polite"
        @click=${handleMarkdownCodeBlockClick}
        ${markdownBlocks()}
        ${ref(syncScroll)}
      >
        ${
          this.companion.loading && turns.length === 0
            ? renderPanelLoadingSkeleton("chat", t("chat.thread.loading"))
            : nothing
        }
        ${
          !this.companion.loading && turns.length === 0
            ? renderPanelEmptyState({
                icon: icons.bot,
                heading: t("chat.sidePanel.companion"),
                description: t("chat.rail.empty"),
              })
            : nothing
        }
        ${turns.map(
          (turn) => html`
            <article
              class="chat-session-rail__exchange ${turn.status === "pending" ? "chat-session-rail__exchange--pending" : turn.status === "failed" ? "chat-session-rail__exchange--error" : ""}"
            >
              <div class="chat-group user chat-session-rail__message">
                <div class="chat-bubble chat-session-rail__question">
                  ${renderMessageMarkdown(
                    turn.question,
                    turn.question,
                    { role: "user", isStreaming: false },
                    { codeBlockChrome: "none", codeBlockInteraction: "static" },
                  )}
                </div>
              </div>
              ${
                turn.status === "answered"
                  ? html`
                      <div class="chat-group assistant chat-session-rail__message">
                        <div class="chat-bubble chat-session-rail__answer">
                          ${renderMessageMarkdown(
                            turn.answer,
                            String(turn.ts),
                            { role: "assistant", isStreaming: false },
                            { codeBlockInteraction: "interactive" },
                          )}
                        </div>
                      </div>
                      <time
                        class="chat-session-rail__timestamp"
                        datetime=${new Date(turn.ts).toISOString()}
                      >
                        ${t("chat.rail.asOf", {
                          time: formatTimeMs(turn.ts, { hour: "numeric", minute: "2-digit" }, ""),
                        })}
                      </time>
                    `
                  : html`
                      <div class="chat-session-rail__hint">
                        ${t(turn.status === "pending" ? "chat.rail.askPending" : COMPANION_HINT_KEYS[turn.hint])}
                      </div>
                      ${
                        turn.status === "failed" &&
                        turn.retryable &&
                        this.connected &&
                        this.onSubmit
                          ? html`<button
                              class="btn btn--secondary chat-session-rail__retry"
                              type="button"
                              ?disabled=${pending}
                              @click=${() => this.onSubmit?.(turn)}
                            >
                              ${t("chat.rail.askRetry")}
                            </button>`
                          : nothing
                      }
                    `
              }
            </article>
          `,
        )}
      </div>
    `;
  }

  override render() {
    this.composer.syncDraft(this.companion.draft);
    const companion = this.companion;
    const reads = companion.attachmentReads;
    const readSignal = reads?.readSignal;
    const attachmentProps: ChatAttachmentControlsProps = {
      uploadConfig: this.uploadConfig,
      attachments: companion.attachments,
      getAttachments: () => companion.attachments ?? [],
      attachmentReads: reads,
      readSignal,
      attachmentLimits: this.attachmentLimits,
      selectionContextOnly: true,
      imagesOnly: true,
      disabled: !this.connected,
      onAttachmentsChange: this.onAttachmentsChange,
      onPendingReadsChange: (delta) => {
        if (readSignal) {
          reads?.updatePending(readSignal, delta);
        }
      },
    };
    const drop = createChatAttachmentDropHandlers({
      ...attachmentProps,
      canCompose: this.connected,
    });
    const pending = this.companion.turns.some((turn) => turn.status === "pending");
    const showPullRequests =
      this.digest &&
      (!this.running || (this.activeRunId && this.digest.runId === this.activeRunId));
    return html`
      <section
        class="chat-session-rail chat-session-rail--expanded chat-session-rail--embedded"
        role="region"
        aria-label=${t("chat.rail.title")}
        tabindex="-1"
        @dragenter=${drop.onDragenter}
        @dragleave=${drop.onDragleave}
        @dragover=${drop.onDragover}
        @drop=${drop.onDrop}
      >
        ${showPullRequests ? this.renderPullRequests() : nothing} ${this.renderThread(pending)}
        ${
          !this.companion.turns.some((turn) => turn.status !== "failed")
            ? this.renderStarters()
            : nothing
        }
        <openclaw-chat-comment-controller
          .paneId=${`side-chat:${this.sessionKey}`}
          .props=${attachmentProps}
          .disabled=${attachmentProps.disabled}
          .sessionKey=${this.sessionKey}
          .presented=${this.presented}
        ></openclaw-chat-comment-controller>
        ${renderSessionRailComposer({ companion, connected: this.connected, pending, sendShortcut: this.sendShortcut, composer: this.composer, attachmentProps, submit: () => this.submit() })}
      </section>
    `;
  }
}

if (!customElements.get("openclaw-chat-session-rail")) {
  customElements.define("openclaw-chat-session-rail", ChatSessionRailElement);
}
