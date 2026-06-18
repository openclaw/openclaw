import type { SettingsAppHost, SettingsHost } from "../../app/app-host.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { defineRoute, type Route } from "../../router/types.ts";
import { startDebugPolling, stopDebugPolling } from "../../ui/app-polling.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { callDebugMethod, loadDebug } from "../../ui/controllers/debug.ts";
import { createLazyView, renderLazyView, type LazyView } from "../../ui/lazy-view.ts";

type DebugViewModule = typeof import("../../ui/views/debug.ts");
type DebugLoadContext = { host: SettingsHost; app: SettingsAppHost };
type DebugRenderContext = { state: AppViewState; invalidate: () => void };

const views = new WeakMap<() => void, LazyView<DebugViewModule>>();

function getView(invalidate: () => void): LazyView<DebugViewModule> {
  const current = views.get(invalidate);
  if (current) {
    return current;
  }
  const next = createLazyView<DebugViewModule>(() => import("../../ui/views/debug.ts"), invalidate);
  views.set(invalidate, next);
  return next;
}

export const route: Route<"debug", DebugLoadContext, DebugRenderContext> = defineRoute({
  id: "debug",
  path: "/debug",
  onEnter: ({ host }) =>
    startDebugPolling(host as unknown as Parameters<typeof startDebugPolling>[0]),
  onLeave: ({ host }) =>
    stopDebugPolling(host as unknown as Parameters<typeof stopDebugPolling>[0]),
  load: async ({ host, app }) => {
    await loadDebug(app);
    host.eventLog = host.eventLogBuffer;
  },
  render: ({ state, invalidate }) =>
    renderSettingsWorkspace(
      state,
      renderLazyView(getView(invalidate), (m) =>
        m.renderDebug({
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
      ),
    ),
});
