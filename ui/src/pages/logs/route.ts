import { html } from "lit";
import { titleForRoute, subtitleForRoute } from "../../app-navigation.ts";
import type { RouteRenderContext } from "../../app-routes.ts";
import type { SettingsAppHost, SettingsHost } from "../../app/app-host.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { definePage } from "../../router/index.ts";
import { loadLogs } from "./data.ts";
import { startLogsPolling, stopLogsPolling } from "./polling.ts";
import { exportLogs, handleLogsScroll, scheduleLogsScroll } from "./scroll.ts";

type LogsRenderContext = RouteRenderContext;
type LogsLoadContext = { host: SettingsHost; app: SettingsAppHost };

export const page = definePage({
  id: "logs",
  path: "/logs",
  component: () =>
    import("./view.ts").then((module) => ({
      render: ({ state, navigate }: LogsRenderContext) => html`
        <section class="content-header">
          <div>
            <div class="page-title">${titleForRoute("logs")}</div>
            <div class="page-sub">${subtitleForRoute("logs")}</div>
          </div>
        </section>
        <section class="content--logs">
          ${renderSettingsWorkspace(
            state.basePath,
            module.renderLogs({
              loading: state.logsLoading,
              error: state.logsError,
              file: state.logsFile,
              entries: state.logsEntries,
              filterText: state.logsFilterText,
              levelFilters: state.logsLevelFilters,
              autoFollow: state.logsAutoFollow,
              truncated: state.logsTruncated,
              onFilterTextChange: (next) => (state.logsFilterText = next),
              onLevelToggle: (level, enabled) => {
                state.logsLevelFilters = { ...state.logsLevelFilters, [level]: enabled };
              },
              onToggleAutoFollow: (next) => (state.logsAutoFollow = next),
              onRefresh: () => void loadLogs(state, { reset: true }),
              onExport: (lines, label) => exportLogs(lines, label),
              onScroll: (event) => handleLogsScroll(state, event),
            }),
            "logs",
            navigate,
          )}
        </section>
      `,
      header: true,
      onStateChange: ({ state }: LogsRenderContext, changed) => {
        if (
          state.logsAutoFollow &&
          state.logsAtBottom &&
          (changed.has("logsEntries") || changed.has("logsAutoFollow"))
        ) {
          scheduleLogsScroll(state, changed.has("logsAutoFollow"));
        }
      },
    })),
  loader: async ({ host, app }: LogsLoadContext) => {
    await loadLogs(app, { reset: true });
    scheduleLogsScroll(host, true);
  },
  onEnter: ({ host }: LogsLoadContext) => {
    startLogsPolling(host);
    host.logsAtBottom = true;
  },
  onLeave: ({ host }: LogsLoadContext) => stopLogsPolling(host),
});
