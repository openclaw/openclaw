import {
  action,
  createEffect,
  createMemo,
  createOptimistic,
  onSettled,
  untrack,
  Show,
} from "solid-js";
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
  const [commandPending, setCommandPending] = createOptimistic(false);
  const observeCommand = action(function* (completion: Promise<unknown>) {
    setCommandPending(true);
    yield completion;
  });
  let active = true;
  onSettled(() => () => {
    active = false;
  });
  function presentCommand(completion: Promise<unknown> | void) {
    if (completion) {
      const epoch = view().commandEpoch;
      const observedCompletion = props.page.observeCommandCompletion(completion);
      // Commit synchronous admission and confirmation UI before observing its completion.
      onSettled(() => {
        if (active && view().commandEpoch === epoch) {
          void observeCommand(observedCompletion);
        }
      });
    }
  }
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
        <SessionsView
          {...view()}
          commandPending={commandPending()}
          onDeleteSelected={() => presentCommand(view().onDeleteSelected())}
          onDeleteAllArchived={() => presentCommand(view().onDeleteAllArchived())}
          onPatch={(...args) => presentCommand(view().onPatch(...args))}
          onAssignCategory={(...args) => presentCommand(view().onAssignCategory(...args))}
        />
      </SettingsWorkspace>
      <Show when={menu()}>
        {(current) => (
          <SessionManagementMenu
            {...current()}
            onAction={(requested) => {
              const completion = current().onAction(requested, presentCommand);
              // Placement reports its admitted write after the chooser has completed.
              if (requested.kind !== "move-session") {
                presentCommand(completion);
              }
            }}
          />
        )}
      </Show>
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
