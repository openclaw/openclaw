import type { SettingsAppHost } from "../../app/app-host.ts";
import { definePage } from "../../router/index.ts";
import { renderUsageTab } from "../../ui/app-render-usage-tab.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { loadUsage } from "../../ui/controllers/usage.ts";

type UsageRenderContext = { state: AppViewState };
type UsageLoadContext = { app: SettingsAppHost };

export const page = definePage({
  id: "usage",
  path: "/usage",
  loader: ({ app }: UsageLoadContext) => loadUsage(app).then(() => undefined),
  component: () =>
    import("../../ui/views/usage.ts").then((module) => ({
      render: ({ state }: UsageRenderContext) => renderUsageTab(state, module),
    })),
});
