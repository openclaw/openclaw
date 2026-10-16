import { createEffect, createMemo, onCleanup, untrack, Show } from "solid-js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { AgentScopeControl } from "../../components/agent-scope-control.tsx";
import { HubTabs } from "../../components/solid/hub-tabs.tsx";
import { LearnMoreLink } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { useApplication } from "../../lib/reactive/context.ts";
import { i18nRevision, t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import "../../styles/settings.css";
import type { SessionsRouteData } from "./route.ts";
import { SessionManagementMenu } from "./session-menu.tsx";
import { SessionsPageController } from "./sessions-page.ts";
import { SessionsView } from "./view.tsx";

export function SessionsPageContent(props: { controller: SessionsPageController }) {
  const context = useApplication();
  const controller = untrack(() => props.controller);
  controller.connect(context);
  onCleanup(() => controller.disconnect());
  const projection = projectSource(controller, {
    read: (owner) => owner.viewProps(),
    subscribe: (owner, notify) => owner.subscribe(notify),
    equality: "revision",
  });
  const view = createMemo(() => {
    i18nRevision();
    return projection.read();
  });
  const menu = createMemo(() => {
    projection.revision();
    return controller.sessionMenuProps();
  });
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
              projection.revision();
              return context.agents.state.agentsList?.agents ?? [];
            })()}
            selection={context.agentSelection}
            selectedId={(() => {
              projection.revision();
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
  const controller = new SessionsPageController();
  controller.routeData = untrack(() => props.routeData);
  createEffect(
    () => props.routeData,
    (routeData) => controller.setRouteData(routeData),
  );
  return (
    <openclaw-sessions-page>
      <SessionsPageContent controller={controller} />
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
