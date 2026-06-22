import type { SettingsAppHost } from "../../app/app-host.ts";
import { definePage } from "../../router/index.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { loadUsage } from "./data.ts";
import { renderUsageTab } from "./render.ts";

type UsageRenderContext = { state: AppViewState };
type UsageLoadContext = { app: SettingsAppHost };

export const page = definePage({
  id: "usage",
  path: "/usage",
  loader: ({ app }: UsageLoadContext) => loadUsage(app).then(() => undefined),
  component: () =>
    import("./view.ts").then((module) => ({
      render: ({ state }: UsageRenderContext) => renderUsageTab(state, module),
    })),
});
