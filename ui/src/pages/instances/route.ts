import type { SettingsAppHost } from "../../app/app-host.ts";
import { definePage } from "../../router/index.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { loadPresence } from "./data.ts";

type InstancesRenderContext = { state: AppViewState };
type InstancesLoadContext = { app: SettingsAppHost };

export const page = definePage({
  id: "instances",
  path: "/instances",
  loader: ({ app }: InstancesLoadContext) => loadPresence(app),
  component: () =>
    import("./view.ts").then((module) => ({
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
