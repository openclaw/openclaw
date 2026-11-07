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
import { registerSessionFoldersEnglish } from "../../i18n/locales/en-session-folders.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import "../../styles/settings.css";
import { i18nRevision, t } from "../../lib/reactive/i18n.ts";
import { SessionFolderView } from "./folder-view.tsx";
import type { SessionsRouteData } from "./route.ts";
import { sessionHubTabs } from "./session-hub-tabs.ts";
import { SessionManagementMenu } from "./session-menu.tsx";
import { createSessionsPage, type SessionsPageOwner } from "./sessions-page-state.ts";
import { SessionsView } from "./view.tsx";
registerSessionFoldersEnglish();

export function SessionsPageContent(props: { page: SessionsPageOwner; folder?: string | null }) {
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
        title={props.folder != null ? props.folder || t("sessionFolders.title") : undefined}
        tabs={sessionHubTabs("sessions", (tab) => context.navigate(tab))}
        docsUrl="https://docs.openclaw.ai/concepts/session"
        class="sessions-hub-header"
        actions={
          <>
            <button
              class="btn btn--sm"
              onClick={() =>
                context.navigate("sessions", { search: props.folder != null ? "" : "?folder=" })
              }
            >
              {t(props.folder != null ? "sessionFolders.allThreads" : "sessionFolders.title")}
            </button>
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
          </>
        }
      />
      <SettingsWorkspace id="sessions-hub-panel">
        <Show
          when={props.folder != null}
          fallback={
            <SessionsView
              {...view()}
              commandPending={commandPending()}
              onDeleteSelected={() => presentCommand(view().onDeleteSelected())}
              onDeleteAllArchived={() => presentCommand(view().onDeleteAllArchived())}
              onPatch={(...args) => presentCommand(view().onPatch(...args))}
              onAssignCategory={(...args) => presentCommand(view().onAssignCategory(...args))}
            />
          }
        >
          <SessionFolderView
            folder={props.folder ?? ""}
            onOpen={(folder) =>
              context.navigate("sessions", { search: `?folder=${encodeURIComponent(folder)}` })
            }
            view={{
              ...view(),
              commandPending: commandPending(),
              onPatch: (...args) => presentCommand(view().onPatch(...args)),
              onAssignCategory: (...args) => presentCommand(view().onAssignCategory(...args)),
            }}
          />
        </Show>
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
      <SessionsPageContent page={page} folder={props.routeData?.folder} />
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
