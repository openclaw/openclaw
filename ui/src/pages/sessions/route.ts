import type { RouteRenderContext } from "../../app-routes.ts";
import type { SettingsAppHost } from "../../app/app-host.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { definePage } from "../../router/index.ts";
import { switchChatSession } from "../../ui/app-render.helpers.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { isPluginEnabledInConfigSnapshot } from "../../ui/plugin-activation.ts";
import { clearChatMessagesFromCache } from "../chat/session-message-cache.ts";
import { loadConfig } from "../config/data.ts";
import {
  branchSessionFromCheckpoint,
  deleteSessionsAndRefresh,
  loadSessions,
  parseSessionsFilterInteger,
  patchSession,
  restoreSessionFromCheckpoint,
  toggleSessionCompactionCheckpoints,
} from "../sessions/data.ts";
import { captureSessionToWorkboard, getWorkboardState } from "../workboard/data.ts";

type SessionsRenderContext = RouteRenderContext;
type SessionsLoadContext = { app: SettingsAppHost };

function runTask<Args extends unknown[]>(
  task: (...args: Args) => Promise<unknown>,
): (...args: Args) => void {
  return (...args) => {
    void task(...args);
  };
}

export const page = definePage({
  id: "sessions",
  path: "/sessions",
  loader: ({ app }: SessionsLoadContext) =>
    Promise.all([loadConfig(app), loadSessions(app)]).then(() => undefined),
  component: () =>
    import("./view.ts").then((module) => ({
      render: ({ state, navigate }: SessionsRenderContext) => {
        const requestUpdate = (state as AppViewState & { requestUpdate?: () => void })
          .requestUpdate;
        const workboardState = getWorkboardState(state);
        const workboardEnabled = isPluginEnabledInConfigSnapshot(
          state.configSnapshot,
          "workboard",
          { enabledByDefault: false },
        );
        const operatorCanWrite = hasOperatorWriteAccess(
          (state.hello as { auth?: { role?: string; scopes?: string[] } } | null)?.auth ?? null,
        );
        return module.renderSessions({
          loading: state.sessionsLoading,
          result: state.sessionsResult,
          error: state.sessionsError,
          activeMinutes: state.sessionsFilterActive,
          limit: state.sessionsFilterLimit,
          includeGlobal: state.sessionsIncludeGlobal,
          includeUnknown: state.sessionsIncludeUnknown,
          showArchived: state.sessionsShowArchived,
          filtersCollapsed: state.sessionsFiltersCollapsed,
          basePath: state.basePath,
          searchQuery: state.sessionsSearchQuery,
          agentIdentityById: state.agentIdentityById,
          sortColumn: state.sessionsSortColumn,
          sortDir: state.sessionsSortDir,
          page: state.sessionsPage,
          pageSize: state.sessionsPageSize,
          selectedKeys: state.sessionsSelectedKeys,
          workboardSessionKeys: new Set(
            workboardState.cards
              .flatMap((card) => [card.sessionKey, card.execution?.sessionKey])
              .filter((key): key is string => typeof key === "string" && key.length > 0),
          ),
          workboardBusySessionKey: [...workboardState.capturingSessionKeys][0] ?? null,
          expandedCheckpointKey: state.sessionsExpandedCheckpointKey,
          checkpointItemsByKey: state.sessionsCheckpointItemsByKey,
          checkpointLoadingKey: state.sessionsCheckpointLoadingKey,
          checkpointBusyKey: state.sessionsCheckpointBusyKey,
          checkpointErrorByKey: state.sessionsCheckpointErrorByKey,
          onFiltersChange: (next) => {
            state.sessionsFilterActive = next.activeMinutes;
            state.sessionsFilterLimit = next.limit;
            state.sessionsIncludeGlobal = next.includeGlobal;
            state.sessionsIncludeUnknown = next.includeUnknown;
            state.sessionsShowArchived = next.showArchived;
            state.sessionsSelectedKeys = new Set();
            state.sessionsPage = 0;
            void loadSessions(state, {
              activeMinutes: parseSessionsFilterInteger(next.activeMinutes),
              limit: parseSessionsFilterInteger(next.limit),
              includeGlobal: next.includeGlobal,
              includeUnknown: next.includeUnknown,
              showArchived: next.showArchived,
            });
          },
          onToggleFiltersCollapsed: () => {
            state.sessionsFiltersCollapsed = !state.sessionsFiltersCollapsed;
          },
          onClearFilters: () => {
            state.sessionsFilterActive = "";
            state.sessionsFilterLimit = "";
            state.sessionsIncludeGlobal = true;
            state.sessionsIncludeUnknown = true;
            state.sessionsShowArchived = true;
            state.sessionsSearchQuery = "";
            state.sessionsSelectedKeys = new Set();
            state.sessionsPage = 0;
            void loadSessions(state, {
              activeMinutes: 0,
              limit: 0,
              includeGlobal: true,
              includeUnknown: true,
              showArchived: true,
            });
          },
          onSearchChange: (query) => {
            state.sessionsSearchQuery = query;
            state.sessionsPage = 0;
          },
          onSortChange: (column, direction) => {
            state.sessionsSortColumn = column;
            state.sessionsSortDir = direction;
            state.sessionsPage = 0;
          },
          onPageChange: (page) => {
            state.sessionsPage = page;
          },
          onPageSizeChange: (pageSize) => {
            state.sessionsPageSize = pageSize;
            state.sessionsPage = 0;
          },
          onRefresh: () => void loadSessions(state),
          onPatch: (key, patch) => void patchSession(state, key, patch),
          onToggleSelect: (key) => {
            const next = new Set(state.sessionsSelectedKeys);
            if (next.has(key)) {
              next.delete(key);
            } else {
              next.add(key);
            }
            state.sessionsSelectedKeys = next;
          },
          onSelectPage: (keys) => {
            const next = new Set(state.sessionsSelectedKeys);
            for (const key of keys) {
              next.add(key);
            }
            state.sessionsSelectedKeys = next;
          },
          onDeselectPage: (keys) => {
            const next = new Set(state.sessionsSelectedKeys);
            for (const key of keys) {
              next.delete(key);
            }
            state.sessionsSelectedKeys = next;
          },
          onDeselectAll: () => {
            state.sessionsSelectedKeys = new Set();
          },
          onDeleteSelected: runTask(async () => {
            const deleted = await deleteSessionsAndRefresh(state, [...state.sessionsSelectedKeys]);
            if (deleted.length === 0) {
              return;
            }
            const next = new Set(state.sessionsSelectedKeys);
            for (const key of deleted) {
              next.delete(key);
              clearChatMessagesFromCache(state.chatMessagesBySession, state, {
                sessionKey: key,
              });
            }
            state.sessionsSelectedKeys = next;
          }),
          onNavigateToChat: (sessionKey) => {
            switchChatSession(state, sessionKey);
            navigate("chat");
          },
          onAddToWorkboard:
            workboardEnabled && operatorCanWrite
              ? runTask(async (session) => {
                  await captureSessionToWorkboard({
                    host: state,
                    client: state.client,
                    session,
                    requestUpdate,
                  });
                  navigate("workboard");
                })
              : undefined,
          onToggleCheckpointDetails: (sessionKey) =>
            void toggleSessionCompactionCheckpoints(state, sessionKey),
          onBranchFromCheckpoint: runTask(async (sessionKey, checkpointId) => {
            const nextKey = await branchSessionFromCheckpoint(state, sessionKey, checkpointId);
            if (nextKey) {
              switchChatSession(state, nextKey);
              navigate("chat");
            }
          }),
          onRestoreCheckpoint: (sessionKey, checkpointId) =>
            void restoreSessionFromCheckpoint(state, sessionKey, checkpointId),
        });
      },
    })),
});
