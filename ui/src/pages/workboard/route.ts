import type { RouteRenderContext } from "../../app-routes.ts";
import type { SettingsAppHost, SettingsHost } from "../../app/app-host.ts";
import { hasOperatorAdminAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { definePage } from "../../router/index.ts";
import { switchChatSession } from "../../ui/app-render.helpers.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { isPluginEnabledInConfigSnapshot } from "../../ui/plugin-activation.ts";
import { loadAgents } from "../agents/data.ts";
import { loadConfig } from "../config/data.ts";
import { loadSessions } from "../sessions/data.ts";
import { loadWorkboard, stopWorkboardLifecycleRefresh, stopWorkboardPolling } from "./data.ts";

type WorkboardRenderContext = RouteRenderContext;
type WorkboardLoadContext = { host: SettingsHost; app: SettingsAppHost };

export const page = definePage({
  id: "workboard",
  path: "/workboard",
  loader: ({ host, app }: WorkboardLoadContext) =>
    Promise.all([
      loadConfig(app),
      loadSessions(app),
      loadAgents(app),
      loadWorkboard({
        host,
        client: app.client,
        requestUpdate: host.requestUpdate,
        refreshDiagnostics: hasOperatorWriteAccess(app.hello?.auth ?? null),
      }),
    ]).then(() => undefined),
  onLeave: ({ host }: WorkboardLoadContext) => {
    stopWorkboardPolling(host);
    stopWorkboardLifecycleRefresh(host);
  },
  component: () =>
    import("./view.ts").then((module) => ({
      contentClass: "content--workboard",
      render: ({ state, navigate }: WorkboardRenderContext) => {
        const requestUpdate = (state as AppViewState & { requestUpdate?: () => void })
          .requestUpdate;
        const auth =
          (state.hello as { auth?: { role?: string; scopes?: string[] } } | null)?.auth ?? null;
        return module.renderWorkboard({
          host: state,
          client: state.client,
          connected: state.connected,
          canWrite: hasOperatorWriteAccess(auth),
          canModelOverride: hasOperatorAdminAccess(auth),
          pluginEnabled: state.configSnapshot
            ? isPluginEnabledInConfigSnapshot(state.configSnapshot, "workboard", {
                enabledByDefault: false,
              })
            : null,
          pluginEnablementError:
            !state.configSnapshot && !state.configLoading ? state.lastError : null,
          agentsList: state.agentsList,
          sessions: state.sessionsResult?.sessions ?? [],
          onOpenSession: (sessionKey) => {
            switchChatSession(state, sessionKey);
            navigate("chat");
          },
          onReloadConfig: () => void loadConfig(state, { discardPendingChanges: true }),
          onRequestUpdate: requestUpdate,
        });
      },
    })),
});
