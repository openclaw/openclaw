import { html } from "lit";
import type { SettingsAppHost, SettingsHost } from "../../app/app-host.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { defineRoute, type Route } from "../../router/types.ts";
import { startLogsPolling, stopLogsPolling } from "../../ui/app-polling.ts";
import { scheduleLogsScroll } from "../../ui/app-scroll.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { loadLogs } from "../../ui/controllers/logs.ts";
import { createLazyView, renderLazyView, type LazyView } from "../../ui/lazy-view.ts";

type LogsViewModule = typeof import("../../ui/views/logs.ts");
type LogsLoadContext = { host: SettingsHost; app: SettingsAppHost };
type LogsRenderContext = { state: AppViewState; invalidate: () => void };

const views = new WeakMap<() => void, LazyView<LogsViewModule>>();

function getView(invalidate: () => void): LazyView<LogsViewModule> {
  const current = views.get(invalidate);
  if (current) {
    return current;
  }
  const next = createLazyView<LogsViewModule>(() => import("../../ui/views/logs.ts"), invalidate);
  views.set(invalidate, next);
  return next;
}

export const route: Route<"logs", LogsLoadContext, LogsRenderContext> = defineRoute({
  id: "logs",
  path: "/logs",
  onEnter: ({ host }) =>
    startLogsPolling(host as unknown as Parameters<typeof startLogsPolling>[0]),
  onLeave: ({ host }) => stopLogsPolling(host as unknown as Parameters<typeof stopLogsPolling>[0]),
  load: async ({ host, app }) => {
    host.logsAtBottom = true;
    await loadLogs(app, { reset: true });
    scheduleLogsScroll(host as unknown as Parameters<typeof scheduleLogsScroll>[0], true);
  },
  render: ({ state, invalidate }) => html`
    <section class="content--logs">
      ${renderSettingsWorkspace(
        state,
        renderLazyView(getView(invalidate), (m) =>
          m.renderLogs({
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
        ),
      )}
    </section>
  `,
});
