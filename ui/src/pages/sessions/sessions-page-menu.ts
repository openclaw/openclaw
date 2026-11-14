import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../../../src/gateway/control-ui-contract.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { togglePinnedSession } from "../../app/bootstrap-navigation-preferences.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasSessionArchiveDescendants } from "../../components/session-menu-descendants.ts";
import { fetchSessionMenuWork } from "../../components/session-menu-work.ts";
import { moveSessionFromMenu } from "../../components/session-placement-action.ts";
import { t } from "../../i18n/index.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { sessionPullRequestsForGateway } from "../../lib/session-pull-requests.ts";
import { scopedSessionArtifactKey } from "../../lib/sessions/session-key.ts";
import { requestSessionInvolvement } from "../../lib/sessions/session-requests.ts";
import { sessionAgentId, sessionPathAgentId } from "./agent-scope.ts";
import type { createSessionsArchive } from "./archive-actions.ts";
import type { createSessionGroups } from "./custom-groups.ts";
import type { SessionsPageMutationResult } from "./mutation-runner.ts";
import type { SessionsPageRequestScope } from "./request-scope.ts";
import {
  handleSessionManagementNavigationAction,
  type SessionsPageMenuProps,
} from "./session-menu.tsx";
import type { createSessionsPageMutations } from "./sessions-page-mutations.ts";
import type { SessionsPageState } from "./sessions-page-state.types.ts";

/** One menu lifetime owns its anchor, optional destinations, and management dispatch. */
export function createSessionsPageMenu(host: {
  context: ApplicationContext;
  state: Pick<
    SessionsPageState,
    "result" | "loading" | "error" | "sessionMenu" | "sessionMenuWork"
  >;
  captureScope: () => SessionsPageRequestScope | null;
  isCurrent: (scope: SessionsPageRequestScope) => boolean;
  isActive: () => boolean;
  groups: Pick<ReturnType<typeof createSessionGroups>, "known" | "assign" | "create">;
  mutations: Pick<
    ReturnType<typeof createSessionsPageMutations>,
    | "patchSession"
    | "forkSession"
    | "runPluginAction"
    | "stopCloudWorker"
    | "deleteSessionFromMenu"
    | "assignOwner"
  >;
  archive: ReturnType<typeof createSessionsArchive>["archive"];
  rename: (row: GatewaySessionRow) => Promise<void>;
  refresh: (scope: SessionsPageRequestScope) => Promise<void>;
  publishError: (scope: SessionsPageRequestScope, error: unknown) => SessionsPageMutationResult;
}) {
  const { context, state, groups, mutations } = host;
  const menuOwner = {};
  let menuTrigger: HTMLElement | null = null;

  function dispose() {
    sessionPullRequestsForGateway(context.gateway).unwatch(menuOwner);
  }

  function open(
    row: GatewaySessionRow,
    position: { x: number; y: number },
    trigger: HTMLElement | null,
  ) {
    if (
      state.sessionMenu?.key === row.key &&
      state.sessionMenu.sessionId === row.sessionId &&
      trigger
    ) {
      close();
      return;
    }
    state.sessionMenu = { key: row.key, sessionId: row.sessionId, ...position };
    menuTrigger = trigger;
    loadSessionMenuWork(row);
  }

  function close() {
    dispose();
    state.sessionMenu = null;
    menuTrigger = null;
    state.sessionMenuWork = null;
  }

  function loadSessionMenuWork(row: GatewaySessionRow) {
    if (!row.worktree) {
      state.sessionMenuWork = null;
      return;
    }
    const scope = host.captureScope();
    if (!scope) {
      state.sessionMenuWork = null;
      return;
    }
    const store = sessionPullRequestsForGateway(scope.context.gateway);
    const pullRequestKey = scopedSessionArtifactKey(
      row.key,
      sessionAgentId(row.key, scope.context),
    );
    state.sessionMenuWork = fetchSessionMenuWork({
      client: scope.client,
      loadPullRequests: canCallGatewayMethod(
        scope.context.gateway.snapshot,
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        "operator.read",
      )
        ? () => store.load(menuOwner, pullRequestKey)
        : undefined,
      worktreeId: row.worktree.id,
      execNode: row.execNode,
    }).then((work) => (host.isCurrent(scope) ? work : null));
  }

  function props(): SessionsPageMenuProps | null {
    const menu = state.sessionMenu;
    const row = menu
      ? state.result?.sessions.find(
          (session) => session.key === menu.key && session.sessionId === menu.sessionId,
        )
      : null;
    if (!menu || !row) {
      return null;
    }
    return {
      context,
      row,
      menu,
      trigger: menuTrigger,
      disabled: state.loading,
      groups: groups.known(),
      work: state.sessionMenuWork,
      onClose: () => close(),
      onAction: (
        requestedAction,
        onAdmittedCommand,
      ): Promise<SessionsPageMutationResult | void> | void => {
        const action = handleSessionManagementNavigationAction(requestedAction, {
          context,
          row,
          isCurrent: host.isActive,
        });
        if (!action) {
          return undefined;
        }
        switch (action.kind) {
          case "toggle-pin":
            togglePinnedSession(context.navigation, row.key);
            break;
          case "toggle-involving-me": {
            const scope = host.captureScope();
            if (!scope || !row.sessionId) {
              state.error = t("sessionsView.actionRequiresConnection");
              break;
            }
            return requestSessionInvolvement(scope.client, {
              key: row.key,
              expectedSessionId: row.sessionId,
              agentId: row.agentId ?? sessionAgentId(row.key, scope.context),
              hidden: !row.hiddenFromInvolvingMe,
            })
              .then(async () => {
                if (host.isCurrent(scope)) {
                  await host.refresh(scope);
                }
              })
              .catch((error: unknown) => host.publishError(scope, error));
          }
          case "toggle-unread":
            return mutations.patchSession(
              row.key,
              { unread: row.unread !== true },
              undefined,
              row.sessionId,
              {
                sessionScope: true,
              },
            );
          case "rename":
            void host.rename(row);
            break;
          case "set-color":
            return mutations.patchSession(row.key, { color: action.color });
          case "set-icon":
            return mutations.patchSession(row.key, { icon: action.icon });
          case "set-communication":
            return mutations.patchSession(
              row.key,
              { communication: action.communication },
              undefined,
              row.sessionId,
            );
          case "reset-appearance":
            return mutations.patchSession(row.key, { icon: null, color: null });
          case "move-session": {
            const scope = host.captureScope();
            if (!scope) {
              state.error = t("sessionsView.actionRequiresConnection");
              break;
            }
            return moveSessionFromMenu({
              context: scope.context,
              row,
              fallbackAgentId: sessionPathAgentId(row.key, scope.context),
              isCurrent: () => host.isCurrent(scope),
              onAdmittedCommand,
              currentRow: () =>
                state.result?.sessions.find(
                  (candidate) => candidate.key === row.key && candidate.sessionId === row.sessionId,
                ),
              publishError: (error) => {
                host.publishError(scope, error);
              },
            }).catch((error: unknown) => host.publishError(scope, error));
          }
          case "fork":
            return mutations.forkSession(row.key, row.hasActiveRun === true);
          case "plugin":
            return mutations.runPluginAction(action.id, menu);
          case "move-to-top-level":
            return mutations.patchSession(
              row.key,
              { sidebarRoot: true },
              undefined,
              row.sessionId,
              {
                sessionScope: true,
              },
            );
          case "move-to-group":
            return groups.assign(row.key, action.category);
          case "new-group":
            void groups.create(row.key);
            break;
          case "toggle-archived": {
            if (row.archived === true) {
              return mutations.patchSession(
                row.key,
                { archived: false },
                undefined,
                row.sessionId,
                {
                  sessionScope: true,
                },
              );
            }
            const rows = state.result?.sessions ?? [];
            return host.archive(row, hasSessionArchiveDescendants(row, rows));
          }
          case "assign-owner":
            return mutations.assignOwner(row, action.owner);
          case "stop-cloud-worker":
            return mutations.stopCloudWorker(row);
          case "delete":
            return mutations.deleteSessionFromMenu(row);
        }
        return undefined;
      },
    };
  }

  return { open, close, props, dispose };
}
