import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { html } from "lit";
import type { SessionsUsageResult } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import {
  renderPanelRefreshStatus,
  type PanelRefreshStatus,
} from "../../components/panel-refresh-status.ts";
import { renderSettingsPageHeader } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";

export function renderUsagePageShell(
  context: ApplicationContext,
  result: SessionsUsageResult | null,
  body: unknown,
) {
  const additionalAgentIds =
    result?.sessions
      .map((entry) => entry.agentId)
      .filter((agentId): agentId is string => Boolean(agentId?.trim())) ?? [];
  return html`
    ${renderSettingsPageHeader({
      title: titleForRoute("usage"),
      subtitle: subtitleForRoute("usage"),
      actions: renderAgentScopeControl({
        agents: context.agents.state.agentsList?.agents ?? [],
        additionalAgentIds,
        selection: context.agentSelection,
      }),
    })}
    ${renderSettingsWorkspace(body)}
  `;
}

export function renderUsageLoadingStatus(label: unknown) {
  return html`
    <span class="settings-status settings-status--accent">
      <span class="usage-loading-spinner" aria-hidden="true"></span>
      ${label}
    </span>
  `;
}

export function renderUsageEmptyState(onRefresh: () => void) {
  return html`
    <section class="settings-group usage-panel usage-empty-state">
      <div class="usage-empty-state__title">${t("usage.empty.title")}</div>
      <div class="card-sub usage-empty-state__subtitle">${t("usage.empty.subtitle")}</div>
      <div class="usage-empty-state__actions">
        <button class="btn primary" @click=${onRefresh}>${t("common.refresh")}</button>
      </div>
    </section>
  `;
}

export function renderUsageRefreshStatus(
  status: PanelRefreshStatus,
  detailKey: string,
  kind: "timeline" | "conversation" | "context",
) {
  return renderPanelRefreshStatus({
    status,
    errorMessage: status.error
      ? t("usage.details.loadFailed", {
          detail: normalizeLowercaseStringOrEmpty(t(detailKey)),
          error: status.error,
        })
      : undefined,
    className: `usage-callout usage-detail-error--${kind}`,
  });
}
