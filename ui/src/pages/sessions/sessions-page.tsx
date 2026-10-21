import { createEffect, createMemo, untrack, Show } from "solid-js";
import { AgentScopeControl } from "../../components/agent-scope-control.tsx";
import { HubPageHeader } from "../../components/solid/hub-page-header.tsx";
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
    <>
      <HubPageHeader<"sessions" | "worktrees">
        active="sessions"
        tabs={{
          id: "sessions",
          items: [
            { value: "sessions", label: t("tabs.sessions") },
            { value: "worktrees", label: t("tabs.worktrees") },
          ],
          ariaLabel: t("sessionsPage.hubTablistLabel"),
          panelId: "sessions-hub-panel",
          onSelect: (tab) => {
            if (tab !== "sessions") {
              context.navigate(tab);
            }
          },
        }}
        docsUrl="https://docs.openclaw.ai/concepts/session"
        class="sessions-hub-header"
        actions={
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
        }
      />
      <SettingsWorkspace id="sessions-hub-panel">
        <SessionsView {...view()} />
      </SettingsWorkspace>
      <Show when={menu()}>{(current) => <SessionManagementMenu {...current()} />}</Show>
    </>
  );
}

export function SessionsPage(props: { routeData?: SessionsRouteData }) {
  // The mount seeds the sessions owner; later route receipts retarget its Gateway queries.
  const initialRouteData = untrack(() => props.routeData);
  const page = createSessionsPage(useApplication(), initialRouteData);
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
