import { createEffect, createMemo, onCleanup, untrack, Show } from "solid-js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { LearnMoreLink } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { i18n } from "../../i18n/index.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectI18n, t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, LitContent } from "../../lit/solid-bridge.ts";
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
  const locale = projectI18n(i18n);
  const view = createMemo(() => {
    locale.revision();
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
          <div class="page-title">
            {(() => {
              locale.revision();
              return titleForRoute("sessions");
            })()}
          </div>
          <div class="page-subtitle">
            {(() => {
              locale.revision();
              return subtitleForRoute("sessions");
            })()}{" "}
            <LearnMoreLink url="https://docs.openclaw.ai/concepts/session" />
          </div>
        </div>
        <div class="hub-page-header__tabs">
          <LitContent
            render={() => {
              locale.revision();
              return renderHubTabs({
                id: "sessions",
                active: "sessions",
                tabs: [
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
              });
            }}
          />
        </div>
        <div class="hub-page-header__actions">
          <LitContent
            render={() => {
              projection.revision();
              locale.revision();
              return renderAgentScopeControl({
                agents: context.agents.state.agentsList?.agents ?? [],
                selection: context.agentSelection,
              });
            }}
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

function SessionsPageRoot(props: { routeData?: SessionsRouteData }) {
  const controller = new SessionsPageController();
  controller.routeData = untrack(() => props.routeData);
  createEffect(
    () => props.routeData,
    (routeData) => controller.setRouteData(routeData),
  );
  return <SessionsPageContent controller={controller} />;
}

export const SessionsPage = defineSolidBridge<{ routeData?: SessionsRouteData }>(
  "openclaw-sessions-page",
  SessionsPageRoot,
  { properties: { routeData: { default: undefined, attribute: false } } },
);
