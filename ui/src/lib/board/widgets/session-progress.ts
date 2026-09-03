import { consume } from "@lit/context";
import { html } from "lit";
import { property } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { renderSessionProgressCard } from "../../../components/session-progress-card.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import {
  sessionProgressCardsForGateway,
  type SessionProgressCardStore,
} from "../../session-progress-cards.ts";
import { isSessionRunActive } from "../../session-run-state.ts";
import { dashboardSessionListQuery } from "../../sessions/index.ts";
import type { BoardWidget } from "../types.ts";
import type { PluginBoardWidgetRenderer } from "./index.ts";

function readSessionKeyProp(widget: BoardWidget | undefined): string | undefined {
  const value = widget?.props?.sessionKey;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

class OpenClawSessionProgressWidget extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) widget?: BoardWidget;
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) active = true;

  private store?: SessionProgressCardStore;
  private targetSessionKey = "";
  private sessionListQueryKey = "";
  private unsubscribe?: () => void;
  private unsubscribeSessions?: () => void;

  override connectedCallback(): void {
    super.connectedCallback();
    this.syncStore();
  }

  override willUpdate(): void {
    this.syncStore();
  }

  override disconnectedCallback(): void {
    this.releaseStore();
    super.disconnectedCallback();
  }

  override render() {
    const loadError = this.store?.getError(this.targetSessionKey);
    if (loadError) {
      return html`<div
        class="board-widget__plugin-loading"
        data-test-id="session-progress-error"
        role="alert"
      >
        <span
          >${t(
            loadError === "access-denied"
              ? "sessionProgressCard.widgetAccessDenied"
              : "sessionProgressCard.widgetUnavailable",
          )}</span
        >
        ${
          loadError === "unavailable"
            ? html`<button class="btn btn--sm" type="button" @click=${this.retryLoad}>
                ${t("common.retry")}
              </button>`
            : null
        }
      </div>`;
    }
    const card = this.store?.get(this.targetSessionKey);
    if (card === undefined) {
      return html`<p class="board-widget__plugin-loading">
        ${t("sessionProgressCard.widgetLoading")}
      </p>`;
    }
    if (card === null) {
      return html`<p class="board-widget__plugin-loading">
        ${t("sessionProgressCard.widgetEmpty")}
      </p>`;
    }
    const context = this.context;
    const sessionListQuery = context
      ? dashboardSessionListQuery(context.agentSelection?.state.scopeId)
      : undefined;
    const sessions = context?.sessions;
    const row =
      sessions && sessionListQuery && typeof sessions.listSnapshot === "function"
        ? sessions
            .listSnapshot(sessionListQuery)
            .result?.sessions.find((entry) => entry.key === this.targetSessionKey)
        : sessions?.state.result?.sessions.find((entry) => entry.key === this.targetSessionKey);
    return renderSessionProgressCard(
      card,
      "board",
      undefined,
      row?.status,
      row?.startedAt,
      row?.endedAt,
      row ? isSessionRunActive(row) : true,
    );
  }

  private syncStore(): void {
    const targetSessionKey = readSessionKeyProp(this.widget) ?? this.sessionKey.trim();
    const sessionListQuery = this.context
      ? dashboardSessionListQuery(this.context.agentSelection?.state.scopeId)
      : undefined;
    const sessionListQueryKey = sessionListQuery ? JSON.stringify(sessionListQuery) : "";
    const store =
      this.active && this.context
        ? sessionProgressCardsForGateway(this.context.gateway)
        : undefined;
    if (
      store === this.store &&
      targetSessionKey === this.targetSessionKey &&
      sessionListQueryKey === this.sessionListQueryKey
    ) {
      return;
    }
    this.releaseStore();
    this.store = store;
    this.targetSessionKey = targetSessionKey;
    this.sessionListQueryKey = sessionListQueryKey;
    if (store && targetSessionKey) {
      store.watch(this, [targetSessionKey]);
      this.unsubscribe = store.subscribe(() => this.requestUpdate());
      const sessions = this.context?.sessions;
      if (
        sessions &&
        sessionListQuery &&
        typeof sessions.subscribeList === "function" &&
        typeof sessions.listSnapshot === "function"
      ) {
        this.unsubscribeSessions = sessions.subscribeList(sessionListQuery, () =>
          this.requestUpdate(),
        );
        const snapshot = sessions.listSnapshot(sessionListQuery);
        if (
          !snapshot.result &&
          !snapshot.loading &&
          !snapshot.error &&
          this.context?.gateway.snapshot.phase === "connected"
        ) {
          void sessions.refreshList({ ...sessionListQuery, force: true });
        }
      }
    }
  }

  private readonly retryLoad = () => {
    if (!this.store || !this.targetSessionKey) {
      return;
    }
    void this.store.load(this.targetSessionKey).catch(() => undefined);
  };

  private releaseStore(): void {
    this.store?.unwatch(this);
    this.unsubscribe?.();
    this.unsubscribeSessions?.();
    this.store = undefined;
    this.unsubscribe = undefined;
    this.unsubscribeSessions = undefined;
  }
}

if (!customElements.get("openclaw-session-progress-widget")) {
  customElements.define("openclaw-session-progress-widget", OpenClawSessionProgressWidget);
}

export const renderSessionProgressWidget: PluginBoardWidgetRenderer = ({
  widget,
  sessionKey,
  active,
}) => html`
  <openclaw-session-progress-widget
    .widget=${widget}
    .sessionKey=${sessionKey}
    .active=${active}
  ></openclaw-session-progress-widget>
`;

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-session-progress-widget": OpenClawSessionProgressWidget;
  }
}
