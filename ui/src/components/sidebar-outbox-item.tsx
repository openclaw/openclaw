import { createMemo, untrack } from "solid-js";
import type { ApplicationContext } from "../app/context.ts";
import { registerSidebarAttentionEnglish } from "../i18n/locales/en-sidebar-attention.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { clampText } from "../lib/format.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { findUiSessionRow, sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import type { SidebarInboxEntry } from "./sidebar-attention-entries.ts";
import "./tooltip.ts";
import "../styles/sidebar-outbox-item.css";
import { Icon } from "./solid/icon.tsx";

registerEnglishCatalog(registerSidebarAttentionEnglish);

export function renderSidebarOutboxItem(params: {
  entry: Extract<SidebarInboxEntry, { type: "outbox" }>;
  context: ApplicationContext;
  onNavigate: ApplicationContext["navigate"];
}) {
  const captured = untrack(() => ({ entry: params.entry, context: params.context }));
  const context = captured.context;
  const connectionRevision = context.gateway.connectionRevision;
  const recoveryScope = context.gateway.snapshot.client?.recoveryScope;
  const view = createMemo(() => {
    const entry = params.entry;
    const currentContext = params.context;
    const row = findUiSessionRow(currentContext, entry.sessionKey, entry.agentId);
    // Global previews omit the old tab/Gateway queue's private message and attachment text.
    const conversation = clampText(
      row?.displayName?.trim() || row?.label?.trim() || t("attention.outbox.conversation"),
      100,
    );
    const agent = currentContext.agents.state.agentsList?.agents.find(
      (item) => item.id === entry.agentId,
    );
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
      context: currentContext,
      face: "chat",
      sessionKey: entry.sessionKey,
      agentId: entry.agentId,
      exactKey: true,
      focusComposer: true,
    });
    const offline = currentContext.gateway.snapshot.phase !== "connected";
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
    return { label, scope, target, offline, guidance, entry };
  });
  return (
    <article
      class={`sidebar-issues-panel__details sidebar-issues-panel__details--${params.entry.severity}`}
      data-attention-kind="outbox"
      data-outbox-id={params.entry.id}
    >
      <div class="sidebar-issues-panel__summary sidebar-outbox-row">
        <span
          class={`sidebar-issues-panel__icon sidebar-outbox-row__icon sidebar-outbox-row__icon--${params.entry.severity}`}
          aria-hidden="true"
        >
          <Icon name="alertTriangle" />
        </span>
        <div class="sidebar-issues-panel__content">
          <span class="sidebar-issues-panel__entity">{view().label}</span>
          <span class="sidebar-outbox-row__meta">
            <span class="sidebar-issues-panel__state" title={view().scope}>
              {view().scope}
            </span>
            {view().offline ? (
              <span class="sidebar-outbox-row__offline">
                <span aria-hidden="true">·</span> {t("attention.outbox.offline")}
              </span>
            ) : null}
          </span>
        </div>
        <openclaw-tooltip prop:content={view().guidance}>
          <a
            class="sidebar-issues-panel__action sidebar-outbox-row__review"
            href={view().target.href}
            aria-label={t("attention.outbox.review")}
            data-issue-row-focus
            onClick={(event) => {
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
                    current.id === captured.entry.id &&
                    current.sessionKey === captured.entry.sessionKey &&
                    current.agentId === captured.entry.agentId,
                )
              ) {
                return;
              }
              const intent = view();
              params.onNavigate("chat", intent.target.options);
              if (intent.entry.dismissal) {
                context.sidebarAttention.dismiss(intent.entry.dismissal);
              }
            }}
          >
            {t("attention.outbox.reviewShort")}
          </a>
        </openclaw-tooltip>
      </div>
    </article>
  );
}
