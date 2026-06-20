import { html } from "lit";
import { titleForRoute, subtitleForRoute } from "../../app-navigation.ts";
import type { SettingsAppHost, SettingsHost } from "../../app/app-host.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { definePage } from "../../router/index.ts";
import { startLogsPolling, stopLogsPolling } from "../../ui/app-polling.ts";
import { scheduleLogsScroll } from "../../ui/app-scroll.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { loadLogs } from "../../ui/controllers/logs.ts";

type LogsRenderContext = { state: AppViewState };
type LogsLoadContext = { host: SettingsHost; app: SettingsAppHost };

export const page = definePage({
  id: "logs",
  path: "/logs",
  component: () =>
    import("../../ui/views/logs.ts").then((module) => ({
      render: ({ state }: LogsRenderContext) => html`
        <section class="content-header">
          <div>
            <div class="page-title">${titleForRoute("logs")}</div>
            <div class="page-sub">${subtitleForRoute("logs")}</div>
          </div>
        </section>
        <section class="content--logs">
          ${renderSettingsWorkspace(
            state,
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
              onExport: (lines, label) => state.exportLogs(lines, label),
              onScroll: (event) => state.handleLogsScroll(event),
            }),
          )}
        </section>
      `,
      header: true,
    })),
  load: async ({ host, app }: LogsLoadContext) => {
    await loadLogs(app, { reset: true });
    scheduleLogsScroll(host as unknown as Parameters<typeof scheduleLogsScroll>[0], true);
  },
  onEnter: ({ host }: LogsLoadContext) => {
    startLogsPolling(host as unknown as Parameters<typeof startLogsPolling>[0]);
    host.logsAtBottom = true;
  },
  onLeave: ({ host }: LogsLoadContext) =>
    stopLogsPolling(host as unknown as Parameters<typeof stopLogsPolling>[0]),
});
