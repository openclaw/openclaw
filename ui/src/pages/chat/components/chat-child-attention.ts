import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { collectSessionDescendantRows } from "../../../components/app-sidebar-session-parent.ts";
import { formatWebUiIconErrorText } from "../../../components/error-presentation.ts";
import { icons } from "../../../components/icons.ts";
import { SESSION_ATTENTION_ICONS } from "../../../components/session-attention-icon-registry.ts";
import { t } from "../../../i18n/index.ts";
import { sessionRowAttention } from "../../../lib/session-attention.ts";
import { resolveSessionDisplayName } from "../../../lib/session-display.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import { isSubagentsPanelSession } from "../chat-spawned-subagent.ts";

/** Child status is a recorded outcome, even when its parent has no new reply. */
export class ChatChildAttention extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) sessions: readonly GatewaySessionRow[] = [];
  @property() sessionKey = "";
  @property({ attribute: false }) onOpenSubagent?: (key: string) => void;
  @property({ attribute: false }) onOpenSession?: (key: string) => void;

  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  override disconnectedCallback() {
    this.clearExpiryTimer();
    super.disconnectedCallback();
  }

  private clearExpiryTimer() {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  override render() {
    this.clearExpiryTimer();
    const now = Date.now();
    const rows = collectSessionDescendantRows(this.sessions, this.sessionKey).flatMap((row) => {
      const attention = sessionRowAttention(row, now);
      return attention.kind === "none" ? [] : [{ row, attention }];
    });
    const expiry = Math.min(
      ...rows.flatMap(({ row, attention }) =>
        attention.kind === "agent" && row.agentStatus ? [row.agentStatus.expiresAt] : [],
      ),
    );
    // Canonical rows own clearing; this one-shot only repaints at their next TTL.
    if (this.isConnected && Number.isFinite(expiry)) {
      this.expiryTimer = setTimeout(() => this.requestUpdate(), Math.max(0, expiry - now + 1));
    }
    return repeat(
      rows,
      ({ row }) => row.key,
      ({ row, attention }) => {
        const note = attention.kind === "agent" ? attention.note : attention.reason;
        const open = isSubagentsPanelSession(row)
          ? (this.onOpenSubagent ?? this.onOpenSession)
          : this.onOpenSession;
        return html`<div
          class="chat-composer-neighbor-card chat-composer-neighbor-card--${attention.kind === "agent" ? "warn" : "danger"} chat-child-attention"
          data-child-session-key=${row.key}
          role=${attention.kind === "agent" ? "status" : "alert"}
        >
          <span class="chat-composer-neighbor-card__icon" aria-hidden="true"
            >${attention.kind === "agent" ? SESSION_ATTENTION_ICONS[attention.icon] : icons.alertTriangle}</span
          >
          <div class="chat-composer-neighbor-card__copy">
            <strong>${resolveSessionDisplayName(row.key, row)}</strong>
            <span>${formatWebUiIconErrorText(note)}</span>
          </div>
          ${open ? html`<button class="btn btn--sm" type="button" @click=${() => open(row.key)}>${t("sessionsView.openSession")}</button>` : nothing}
        </div>`;
      },
    );
  }
}

if (!customElements.get("openclaw-chat-child-attention")) {
  customElements.define("openclaw-chat-child-attention", ChatChildAttention);
}
