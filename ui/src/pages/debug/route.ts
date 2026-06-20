import { html } from "lit";
import { titleForRoute, subtitleForRoute } from "../../app-navigation.ts";
import type { SettingsAppHost, SettingsHost } from "../../app/app-host.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { definePage } from "../../router/index.ts";
import { startDebugPolling, stopDebugPolling } from "../../ui/app-polling.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { callDebugMethod, loadDebug } from "../../ui/controllers/debug.ts";

type DebugRenderContext = { state: AppViewState };
type DebugLoadContext = { host: SettingsHost; app: SettingsAppHost };

export const page = definePage({
  id: "debug",
  path: "/debug",
  component: () =>
    import("../../ui/views/debug.ts").then((module) => ({
      render: ({ state }: DebugRenderContext) => html`
        <section class="content-header">
          <div>
            <div class="page-title">${titleForRoute("debug")}</div>
            <div class="page-sub">${subtitleForRoute("debug")}</div>
          </div>
        </section>
        ${renderSettingsWorkspace(
          state,
          module.renderDebug({
            loading: state.debugLoading,
            status: state.debugStatus,
            health: state.debugHealth,
            models: state.debugModels,
            heartbeat: state.debugHeartbeat,
            eventLog: state.eventLog,
            methods: (state.hello?.features?.methods ?? []).toSorted(),
            callMethod: state.debugCallMethod,
            callParams: state.debugCallParams,
            callResult: state.debugCallResult,
            callError: state.debugCallError,
            onCallMethodChange: (next) => (state.debugCallMethod = next),
            onCallParamsChange: (next) => (state.debugCallParams = next),
            onRefresh: () => void loadDebug(state),
            onCall: () => void callDebugMethod(state),
          }),
        )}
      `,
      header: true,
    })),
  load: async ({ host, app }: DebugLoadContext) => {
    await loadDebug(app);
    host.eventLog = host.eventLogBuffer;
  },
  onEnter: ({ host }: DebugLoadContext) => {
    startDebugPolling(host as unknown as Parameters<typeof startDebugPolling>[0]);
  },
  onLeave: ({ host }: DebugLoadContext) =>
    stopDebugPolling(host as unknown as Parameters<typeof stopDebugPolling>[0]),
});
