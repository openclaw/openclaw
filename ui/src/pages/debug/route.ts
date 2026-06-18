import type { SettingsAppHost, SettingsHost } from "../../app/app-host.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { lazyPage } from "../../router/lazy-page.ts";
import { definePage, type Page } from "../../router/types.ts";
import { startDebugPolling, stopDebugPolling } from "../../ui/app-polling.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { callDebugMethod, loadDebug } from "../../ui/controllers/debug.ts";

type DebugViewModule = typeof import("../../ui/views/debug.ts");
type DebugLoadContext = { host: SettingsHost; app: SettingsAppHost };
type DebugRenderContext = { state: AppViewState; invalidate: () => void };

const renderDebugView = lazyPage<DebugViewModule, DebugRenderContext>(
  () => import("../../ui/views/debug.ts"),
  (module, { state }) =>
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
);

export const page: Page<DebugLoadContext, DebugRenderContext> = definePage({
  onEnter: ({ host }) =>
    startDebugPolling(host as unknown as Parameters<typeof startDebugPolling>[0]),
  onLeave: ({ host }) =>
    stopDebugPolling(host as unknown as Parameters<typeof stopDebugPolling>[0]),
  load: async ({ host, app }) => {
    await loadDebug(app);
    host.eventLog = host.eventLogBuffer;
  },
  render: ({ state, invalidate }) =>
    renderSettingsWorkspace(state, renderDebugView({ state, invalidate })),
});
