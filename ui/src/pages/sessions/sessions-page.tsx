import { createEffect, createMemo, untrack, Show } from "solid-js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { AgentScopeControl } from "../../components/agent-scope-control.tsx";
import { HubTabs } from "../../components/solid/hub-tabs.tsx";
import { LearnMoreLink } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { useApplication } from "../../lib/reactive/context.ts";
import { i18nRevision, t } from "../../lib/reactive/i18n.ts";
import "../../styles/settings.css";
import type { SessionsRouteData } from "./route.ts";
import { SessionManagementMenu } from "./session-menu.tsx";
import { createSessionsPage, type SessionsPageOwner } from "./sessions-page-state.ts";
import { SessionsView } from "./view.tsx";

export function SessionsPageContent(props: { page: SessionsPageOwner }) {
  const context = useApplication();
  const view = createMemo(() => {
    i18nRevision();
    return props.page.view();
  });
  const menu = () => props.page.menu();
  return (
    <ShellLayoutBoundary traits={{ toolbarHeader: true }}>
      <section class="content-header content-header--settings content-header--page hub-page-header sessions-hub-header">
        <div class="hub-page-header__title">
          <div class="page-title">{titleForRoute("sessions", t)}</div>
          <div class="page-subtitle">
            {subtitleForRoute("sessions", t)}{" "}
            <LearnMoreLink url="https://docs.openclaw.ai/concepts/session" />
          </div>
        </div>
        <div class="hub-page-header__tabs">
          <HubTabs<"sessions" | "worktrees">
            id="sessions"
            active="sessions"
            tabs={[
              { value: "sessions", label: t("tabs.sessions") },
              { value: "worktrees", label: t("tabs.worktrees") },
            ]}
            ariaLabel={t("sessionsPage.hubTablistLabel")}
            panelId="sessions-hub-panel"
            onSelect={(tab) => {
              if (tab !== "sessions") {
                context.navigate(tab);
              }
            }}
          />
        </div>
        <div class="hub-page-header__actions">
          <AgentScopeControl
            agents={(() => {
              props.page.revision();
              return context.agents.state.agentsList?.agents ?? [];
            })()}
            selection={context.agentSelection}
            selectedId={(() => {
              props.page.revision();
              return context.agentSelection.state.scopeId;
            })()}
          />
        </div>
      </section>
      <SettingsWorkspace id="sessions-hub-panel">
        <SessionsView {...view()} />
      </SettingsWorkspace>
      <Show when={menu()}>{(current) => <SessionManagementMenu {...current()} />}</Show>
    </ShellLayoutBoundary>
  );
}

export function SessionsPage(props: { routeData?: SessionsRouteData }) {
  // The mount seeds the sessions owner; later route receipts retarget its Gateway queries.
  const page = createSessionsPage(
    useApplication(),
    untrack(() => props.routeData),
  );
  createEffect(
    () => props.routeData,
    (routeData) => page.setRouteData(routeData),
  );
  return (
    <openclaw-sessions-page>
      <SessionsPageContent page={page} />
    </openclaw-sessions-page>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-sessions-page": HTMLAttributes<HTMLElement>;
    }
  }
}
