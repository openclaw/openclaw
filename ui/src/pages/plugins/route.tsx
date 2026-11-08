import { definePage, type RouteLoaderOptions, type RouteLocation } from "@openclaw/uirouter";
import { routePageSpec } from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-route-types.tsx";
import type { ApplicationContext } from "../../app/context.ts";
import { pluginsRouteLocation, type PluginsRouteData } from "./route-data.ts";

type PluginsSurface = "discovery" | "settings";

function definePluginsPage(routeId: "plugins" | "plugin-settings", surface: PluginsSurface) {
  return definePage({
    ...routePageSpec(routeId),
    loaderDeps: (_context: ApplicationContext, location: RouteLocation) => {
      const routeLocation = pluginsRouteLocation(location);
      return `${routeLocation.pathname}\u0000${routeLocation.search}\u0000${routeLocation.hash}`;
    },
    loader: (_context: ApplicationContext, options: RouteLoaderOptions) => {
      const location = pluginsRouteLocation(options.location);
      return { location } satisfies PluginsRouteData;
    },
    component: async () => {
      const { PluginsPage } = await import("./plugins-page.tsx");
      if (surface === "settings") {
        // Let module evaluation finish its task before replacing the previous page.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }
      return {
        renderSolid: (props: SolidRouteProps<PluginsRouteData>) => (
          <PluginsPage routeData={props.data} surface={surface} />
        ),
      };
    },
  });
}

const page = definePluginsPage("plugins", "discovery");
const settingsPage = definePluginsPage("plugin-settings", "settings");
export const pages = [page, settingsPage] as const;
