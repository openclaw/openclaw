import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  pluginPageParams,
  pluginTabKey,
  pluginTabRefFromSearch,
  type PluginTabRef,
} from "./target.ts";

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
