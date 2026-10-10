import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import {
  INTERNAL_PLUGIN_PATH_PARAM,
  pluginTabSlugFromPath,
  routePageSpec,
} from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";

type PluginTabRef = {
  pluginId: string;
  id: string;
};

export function pluginTabRefFromSearch(search: string, pathname = "", basePath = ""): PluginTabRef {
  const params = new URLSearchParams(search);
  const tab = pluginTabSlugFromPath(params.get(INTERNAL_PLUGIN_PATH_PARAM) ?? pathname, basePath);
  return {
    pluginId: tab?.pluginId ?? params.get("plugin")?.trim() ?? "",
    id: tab?.id ?? params.get("id")?.trim() ?? "",
  };
}

/** Stable key for one tab; ids are only unique per plugin, so both parts matter. */
export function pluginTabKey(ref: PluginTabRef): string {
  return `${ref.pluginId}/${ref.id}`;
}

function pluginPageParams(search: string): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...new URLSearchParams(search)]
      .filter(([key]) => key.startsWith("p."))
      .map(([key, value]) => [key.slice(2), value]),
  );
}

// The synthetic search parameter carries dynamic paths through the exact-path router.
export const page = definePage({
  ...routePageSpec("plugin"),
  loaderDeps: (context: ApplicationContext, location) =>
    JSON.stringify([
      pluginTabKey(pluginTabRefFromSearch(location.search, location.pathname, context.basePath)),
      pluginPageParams(location.search),
    ]),
  loader: (context: ApplicationContext, options) => ({
    ...pluginTabRefFromSearch(options.location.search, options.location.pathname, context.basePath),
    params: pluginPageParams(options.location.search),
  }),
  component: () =>
    import("./plugin-page.ts").then(() => ({
      header: true,
      render: (data: unknown) => {
        const ref = (data ?? { pluginId: "", id: "", params: {} }) as PluginTabRef & {
          params: Readonly<Record<string, string>>;
        };
        return html`<openclaw-plugin-page
          .pluginId=${ref.pluginId}
          .tabId=${ref.id}
          .params=${ref.params}
        >
        </openclaw-plugin-page>`;
      },
    })),
});
