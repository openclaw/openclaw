import type { SettingsAppHost } from "../../app/app-host.ts";
import { definePage } from "../../router/index.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { loadPresence } from "../../ui/controllers/presence.ts";

type InstancesRenderContext = { state: AppViewState };
type InstancesLoadContext = { app: SettingsAppHost };

export const page = definePage({
  id: "instances",
  path: "/instances",
  load: ({ app }: InstancesLoadContext) => loadPresence(app),
  component: () =>
    import("../../ui/views/instances.ts").then((module) => ({
      render: ({ state }: InstancesRenderContext) =>
        module.renderInstances({
          loading: state.presenceLoading,
          entries: state.presenceEntries,
          lastError: state.presenceError,
          statusMessage: state.presenceStatus,
          onRefresh: () => void loadPresence(state),
        }),
    })),
});
