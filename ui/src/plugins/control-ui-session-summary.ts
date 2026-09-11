import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { AgentsListResult } from "../api/types.ts";
import "../components/agent-avatar.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { icons } from "../components/icons.ts";
import { toSanitizedMarkdownHtml } from "../components/markdown.ts";
import { SessionProgressCardController } from "../components/session-progress-card-controller.ts";
import { renderSessionProgressCard } from "../components/session-progress-card.ts";
import { t } from "../i18n/index.ts";
import { extractText } from "../lib/chat/message-extract.ts";
import { normalizeMessage } from "../lib/chat/message-normalizer.ts";
import { formatSenderLabel } from "../lib/chat/sender-label.ts";
import { readSessionChangedEvent } from "../lib/sessions/reconcile.ts";
import { uiSessionEventMatches, parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import type { ChatHistoryResult } from "../pages/chat/chat-history-snapshot.ts";
import "../styles/chat/progress-card.css";
import "../styles/sidebar-markdown.css";
import "../styles/plugin-session-summary.css";
import { renderChatAuthorAvatar } from "../pages/chat/components/chat-author-avatar.ts";

class PluginSessionSummary extends OpenClawLightDomElement {
  @property({ attribute: false }) session: BoardGetParams | null = null;
  @property({ attribute: false }) gateway: ApplicationGateway | null = null;
  @property({ attribute: false }) presented = false;
  @property({ attribute: false }) agents: AgentsListResult["agents"] = [];
  @state() private history: ChatHistoryResult | null = null;
  @state() private loading = false;
  @state() private error = false;
  private requestKey = "";
  private requestClient: unknown;
  private requestGateway: ApplicationGateway | null = null;
  private generation = 0;
  private pending = false;
  private dirty = false;
  constructor() {
    super();
    new SubscriptionsController(this)
      .watch(
        () => (this.presented ? this.gateway : null),
        (gateway, notify) => gateway.subscribe(notify),
      )
      .effect(
        () => (this.presented ? this.gateway : null),
        (gateway) =>
          gateway.subscribeEvents((event) => {
            if (event.event !== "sessions.changed" && event.event !== "session.message") {
              return;
            }
            const changed = readSessionChangedEvent(event.payload);
            const target = this.session;
            if (
              !changed ||
              !target ||
              !this.presented ||
              !uiSessionEventMatches(
                {
                  ...gateway.snapshot,
                  sessionKey: target.sessionKey,
                  assistantAgentId: target.agentId ?? gateway.snapshot.assistantAgentId,
                },
                changed.key,
                changed.agentId,
              )
            ) {
              return;
            }
            // Durable message/lifecycle broadcasts invalidate history; token deltas do not.
            this.dirty = true;
            this.requestUpdate();
          }),
      );
  }

  private readonly progress = new SessionProgressCardController(this, {
    gateway: () => (this.presented ? this.gateway : undefined),
    target: () => (this.presented ? this.session : undefined),
  });

  override updated() {
    const snapshot = this.gateway?.snapshot;
    const client = snapshot?.phase === "connected" ? snapshot.client : null;
    const target = this.session;
    const key =
      this.presented && this.isConnected && client && target
        ? JSON.stringify([target.sessionKey, target.agentId, this.gateway?.connectionRevision])
        : "";
    if (
      key !== this.requestKey ||
      client !== this.requestClient ||
      this.gateway !== this.requestGateway
    ) {
      this.requestGateway = this.gateway;
      this.requestKey = key;
      this.requestClient = client;
      ++this.generation;
      this.pending = false;
      this.dirty = Boolean(key);
      this.history = null;
      this.error = false;
      this.loading = Boolean(key);
    }
    if (!key || !client || !target || this.pending || !this.dirty) {
      return;
    }
    this.dirty = false;
    this.pending = true;
    this.error = false;
    const generation = this.generation;
    const gateway = this.gateway;
    const connectionRevision = gateway?.connectionRevision;
    const current = () =>
      generation === this.generation &&
      this.isConnected &&
      this.presented &&
      this.gateway === gateway &&
      gateway?.snapshot.phase === "connected" &&
      gateway.snapshot.client === client &&
      gateway.connectionRevision === connectionRevision &&
      this.session?.sessionKey === target.sessionKey &&
      this.session?.agentId === target.agentId;
    void client
      .request<ChatHistoryResult>("chat.history", {
        ...target,
        limit: 20,
        maxChars: 12000,
      })
      .then((history) => {
        if (!current()) {
          return;
        }
        this.history = history;
      })
      .catch(() => {
        if (current()) {
          this.error = true;
        }
      })
      .finally(() => {
        if (!current()) {
          return;
        }
        this.pending = false;
        this.loading = false;
        if (this.dirty) {
          this.requestUpdate();
        }
      });
  }

  override disconnectedCallback() {
    ++this.generation;
    this.requestKey = "";
    this.requestClient = undefined;
    super.disconnectedCallback();
  }

  private retry = () => {
    this.dirty = true;
    this.progress.retry();
    this.requestUpdate();
  };

  override render() {
    if (!this.presented) {
      return nothing;
    }
    if (this.gateway?.snapshot.phase !== "connected") {
      return html`<p role="status">${t("pluginUi.sessionHistoryUnavailable")}</p>`;
    }
    const card = this.progress.card;
    const row = this.history?.sessionInfo;
    const messages = (this.history?.messages ?? []).slice(-20).flatMap((message) => {
      if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")) {
        return [];
      }
      const text = extractText(message);
      if (!text) {
        return [];
      }
      const normalized = normalizeMessage(message);
      const sender = normalized.sender;
      const senderAgentId =
        normalized.senderSession?.agentId ??
        parseAgentSessionKey(normalized.senderSession?.sessionKey)?.agentId;
      const agentId = normalized.senderSession
        ? senderAgentId
        : message.role === "assistant"
          ? (this.session?.agentId ?? parseAgentSessionKey(this.session?.sessionKey)?.agentId)
          : undefined;
      const agent = agentId ? this.agents.find((entry) => entry.id === agentId) : undefined;
      const label =
        formatSenderLabel(sender) ??
        agent?.name ??
        agent?.identity?.name ??
        (agentId || t(message.role === "user" ? "sessionsView.user" : "sessionsView.assistant"));
      // Missing sender metadata never identifies a message as belonging to the current viewer.
      const avatar = sender
        ? renderChatAuthorAvatar(sender)
        : agent
          ? html`<openclaw-agent-avatar
              .option=${{ value: agent.id, label, agent }}
            ></openclaw-agent-avatar>`
          : html`<span class="plugin-session-summary__unknown" aria-hidden="true"
              >${message.role === "user" ? icons.users : icons.bot}</span
            >`;
      const timestamp =
        typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
          ? new Date(message.timestamp)
          : null;
      const time = timestamp && Number.isFinite(timestamp.getTime()) ? timestamp : null;
      return [{ text, label, avatar, time }];
    });
    return html`<div class="plugin-session-summary">
      ${
        this.progress.error || this.progress.loading || card
          ? html`<section class="plugin-session-summary__progress">
              ${
                this.progress.error
                  ? html`<p role="alert">${t("sessionProgressCard.widgetUnavailable")}</p>`
                  : this.progress.loading
                    ? html`<p>${t("sessionProgressCard.widgetLoading")}</p>`
                    : card
                      ? renderSessionProgressCard(
                          card,
                          "board",
                          undefined,
                          row?.status,
                          row?.startedAt,
                          row?.endedAt,
                          row?.hasActiveRun === true,
                        )
                      : nothing
              }
            </section>`
          : nothing
      }
      <section
        class="plugin-session-summary__history"
        aria-label=${t("pluginUi.sessionRecentMessages")}
      >
        <h3>${t("pluginUi.sessionRecentMessages")}</h3>
        ${
          this.loading || (!this.history && !this.error)
            ? html`<p>${t("common.loading")}</p>`
            : this.error
              ? html`<p role="alert">${t("pluginUi.sessionHistoryUnavailable")}</p>`
              : messages.length
                ? messages.map(
                    (message) => html`<article class="plugin-session-summary__message">
                      <header class="plugin-session-summary__message-header">
                        <span class="plugin-session-summary__avatar">${message.avatar}</span>
                        <strong class="plugin-session-summary__role">${message.label}</strong>
                        ${
                          message.time
                            ? html`<time
                                datetime=${message.time.toISOString()}
                                title=${message.time.toLocaleString()}
                                >${message.time.toLocaleTimeString(undefined, {
                                  hour: "numeric",
                                  minute: "2-digit",
                                })}</time
                              >`
                            : nothing
                        }
                      </header>
                      <div class="sidebar-markdown">
                        ${unsafeHTML(toSanitizedMarkdownHtml(message.text))}
                      </div>
                    </article>`,
                  )
                : html`<p>${t("pluginUi.sessionHistoryEmpty")}</p>`
        }
      </section>
      ${
        this.error || this.progress.error
          ? html`<button class="btn" @click=${this.retry}>${t("common.retry")}</button>`
          : nothing
      }
    </div>`;
  }
}
if (!customElements.get("openclaw-plugin-session-summary")) {
  customElements.define("openclaw-plugin-session-summary", PluginSessionSummary);
}
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugin-session-summary": PluginSessionSummary;
  }
}
