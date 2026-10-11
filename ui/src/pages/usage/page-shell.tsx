import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { JSX } from "@solidjs/web";
import { createMemo, untrack } from "solid-js";
import type { SessionsUsageResult } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import type { PanelRefreshStatus } from "../../components/panel-refresh-status.ts";
import { PanelRefreshStatus as PanelRefreshStatusView } from "../../components/solid/panel-refresh-status.tsx";
import { SettingsPageHeader } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { projectAgentSelection } from "../../lib/reactive/application.ts";
import { projectAgents } from "../../lib/reactive/domain-capabilities.ts";
import { getLocale, t } from "../../lib/reactive/i18n.ts";
import { LitContent } from "../../lit/solid-bridge.ts";

export function UsagePageShell(props: {
  context: ApplicationContext;
  result: SessionsUsageResult | null;
  children: JSX.Element;
}) {
  // The bridge replaces this view when the application provider changes.
  const context = untrack(() => props.context);
  const agents = projectAgents(context.agents);
  const selection = projectAgentSelection(context.agentSelection);
  const header = createMemo(() => {
    getLocale();
    return { title: titleForRoute("usage"), subtitle: subtitleForRoute("usage") };
  });
  const additionalAgentIds = createMemo(
    () =>
      props.result?.sessions
        .map((entry) => entry.agentId)
        .filter((agentId): agentId is string => Boolean(agentId?.trim())) ?? [],
  );
  return (
    <>
      <SettingsPageHeader
        title={header().title}
        subtitle={header().subtitle}
        actions={
          <LitContent
            render={() =>
              renderAgentScopeControl({
                agents: agents.read().agentsList?.agents ?? [],
                additionalAgentIds: additionalAgentIds(),
                selection: props.context.agentSelection,
                selectedId: selection.read().state.scopeId,
              })
            }
          />
        }
      />
      <SettingsWorkspace>{props.children}</SettingsWorkspace>
    </>
  );
}

export function renderUsageLoadingStatus(label: JSX.Element) {
  return (
    <span class="settings-status settings-status--accent">
      <span class="usage-loading-spinner" aria-hidden="true" />
      {label}
    </span>
  );
}

export function renderUsageEmptyState(onRefresh: () => void) {
  return (
    <section class="settings-group usage-panel usage-empty-state">
      <div class="usage-empty-state__title">{t("usage.empty.title")}</div>
      <div class="card-sub usage-empty-state__subtitle">{t("usage.empty.subtitle")}</div>
      <div class="usage-empty-state__actions">
        <button class="btn primary" onClick={onRefresh}>
          {t("common.refresh")}
        </button>
      </div>
    </section>
  );
}

export function renderUsageRefreshStatus(
  status: PanelRefreshStatus,
  detailKey: string,
  kind: "timeline" | "conversation" | "context",
) {
  return (
    <PanelRefreshStatusView
      status={status}
      errorMessage={
        status.error
          ? t("usage.details.loadFailed", {
              detail: normalizeLowercaseStringOrEmpty(t(detailKey)),
              error: status.error,
            })
          : undefined
      }
      {...{ className: `usage-callout usage-detail-error--${kind}` }}
    />
  );
}
