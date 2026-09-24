import { html, nothing } from "lit";
import type { ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { registerSidebarAttentionEnglish } from "../i18n/locales/en-sidebar-attention.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { clampText } from "../lib/format.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { findUiSessionRow, sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { icons } from "./icons.ts";
import "./tooltip.ts";
import "../styles/sidebar-outbox-item.css";
import type { SidebarInboxEntry } from "./sidebar-attention-entries.ts";

registerSidebarAttentionEnglish();

export function renderSidebarOutboxItem(params: {
  entry: Extract<SidebarInboxEntry, { type: "outbox" }>;
  context: ApplicationContext;
  onNavigate: ApplicationContext["navigate"];
}) {
  const { entry, context } = params;
  const connectionRevision = context.gateway.connectionRevision;
  const recoveryScope = context.gateway.snapshot.client?.recoveryScope;
  const row = findUiSessionRow(context, entry.sessionKey, entry.agentId);
  // The old tab/Gateway queue has no uniform human owner. Do not promote its
  // message text, attachment names, or diagnostic payloads into global previews.
  const conversation = clampText(
    row?.displayName?.trim() || row?.label?.trim() || t("attention.outbox.conversation"),
    100,
  );
  const agent = context.agents.state.agentsList?.agents.find((item) => item.id === entry.agentId);
  const scope = agent
    ? `${clampText(normalizeAgentLabel(agent), 60)} · ${conversation}`
    : conversation;
  const label = t(
    entry.command
      ? entry.unconfirmed
        ? "attention.outbox.commandUnconfirmed"
        : "attention.outbox.commandFailed"
      : entry.unconfirmed
        ? "attention.outbox.unconfirmed"
        : "attention.outbox.failed",
  );
  const target = sessionNavigationTarget({
    context,
    face: "chat",
    sessionKey: entry.sessionKey,
    agentId: entry.agentId,
    exactKey: true,
    focusComposer: true,
  });
  const offline = context.gateway.snapshot.phase !== "connected";
  const guidance = [
    t(
      entry.unconfirmed
        ? entry.command
          ? "attention.outbox.checkCommandBeforeRetry"
          : "attention.outbox.checkBeforeRetry"
        : "attention.outbox.reviewHint",
    ),
    ...(offline ? [t("attention.outbox.offlineHint")] : []),
  ].join(" ");
  return html`<article
    class="sidebar-issues-panel__details sidebar-issues-panel__details--${entry.severity}"
    data-attention-kind="outbox"
    data-outbox-id=${entry.id}
  >
    <div class="sidebar-issues-panel__summary sidebar-outbox-row">
      <span
        class="sidebar-issues-panel__icon sidebar-outbox-row__icon sidebar-outbox-row__icon--${entry.severity}"
        aria-hidden="true"
        >${icons.alertTriangle}</span
      >
      <div class="sidebar-issues-panel__content">
        <span class="sidebar-issues-panel__entity">${label}</span>
        <span class="sidebar-outbox-row__meta">
          <span class="sidebar-issues-panel__state" title=${scope}>${scope}</span>
          ${offline ? html`<span class="sidebar-outbox-row__offline"><span aria-hidden="true">·</span> ${t("attention.outbox.offline")}</span>` : nothing}
        </span>
      </div>
      <openclaw-tooltip .content=${guidance}>
        <a
          class="sidebar-issues-panel__action sidebar-outbox-row__review"
          href=${target.href}
          aria-label=${t("attention.outbox.review")}
          data-issue-row-focus
          @click=${(event: MouseEvent) => {
            if (!shouldHandleNavigationClick(event)) {
              return;
            }
            event.preventDefault();
            // A retained DOM handler cannot navigate a retired Gateway or delivery row.
            if (
              context.gateway.connectionRevision !== connectionRevision ||
              context.gateway.snapshot.client?.recoveryScope !== recoveryScope ||
              !context.sidebarAttention.entries.some(
                (current) =>
                  current.type === "outbox" &&
                  current.id === entry.id &&
                  current.sessionKey === entry.sessionKey &&
                  current.agentId === entry.agentId,
              )
            ) {
              return;
            }
            params.onNavigate("chat", target.options);
          }}
          >${t("attention.outbox.reviewShort")}</a
        >
      </openclaw-tooltip>
    </div>
  </article>`;
}
