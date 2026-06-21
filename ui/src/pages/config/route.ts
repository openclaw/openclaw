import type { RouteRenderContext } from "../../app-routes.ts";
import type { SettingsAppHost, SettingsHost } from "../../app/app-host.ts";
import { definePage } from "../../router/index.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { loadSettingsPage } from "../loaders.ts";
import type { ConfigPageId } from "./page.ts";

type ConfigLoadContext = { host: SettingsHost; app: SettingsAppHost };
type ConfigRenderContext = RouteRenderContext;

function configPage(id: ConfigPageId, path: string) {
  return definePage({
    id,
    path,
    loader: ({ host, app }: ConfigLoadContext) => loadSettingsPage(host, app),
    component: () =>
      import("./page.ts").then((module) => ({
        header: true,
        render: ({ state, navigate }: ConfigRenderContext) =>
          module.renderConfigRoute(state, id, navigate),
      })),
  });
}

export const pages = [
  configPage("config", "/config"),
  configPage("communications", "/communications"),
  configPage("appearance", "/appearance"),
  configPage("automation", "/automation"),
  configPage("mcp", "/mcp"),
  configPage("infrastructure", "/infrastructure"),
  configPage("ai-agents", "/ai-agents"),
] as const;
