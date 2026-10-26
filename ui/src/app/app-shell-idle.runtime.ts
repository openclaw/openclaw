import { isSessionRouteId } from "../app-route-paths.ts";
import type { ShellOwner } from "./app-host.tsx";
import type { ApplicationContext } from "./context.ts";
import { connectControlUiFavicon } from "./control-ui-favicon-status.runtime.ts";
import { connectNavigationPrefetch } from "./navigation-prefetch.ts";

/** Optional shell services share the existing deferred import and its lifetime. */
export function connectShellIdle(
  host: ShellOwner,
  context: ApplicationContext,
  startedAt: number,
): () => void {
  const stopFavicon = connectControlUiFavicon(
    host.element,
    context,
    () => host.queryRenderedElements("openclaw-chat-pane"),
    startedAt,
  );
  const stopPrefetch = connectNavigationPrefetch({
    shell: host.element,
    router: context.router,
    gateway: context.gateway,
    outlet: () => host.routeOutlet,
    basePath: context.basePath,
    resourceBasePath: context.resourceBasePath,
    preloadRoute: context.preload,
    transcriptsReady: () => {
      const panes = host
        .queryRenderedElements("openclaw-chat-pane")
        .filter((pane) => pane.presented && pane.visuallyPresented);
      const routeId = context.router.getState().matches[0]?.routeId;
      const pluginsReady = host
        .queryRenderedElements("openclaw-plugin-page")
        .every((page) => !context.plugins.isLoading(page.pluginId ?? ""));
      return (
        pluginsReady &&
        (!routeId || !isSessionRouteId(routeId) || panes.length > 0) &&
        panes.every(
          (pane) =>
            !pane.conversationPresented ||
            (pane.transcriptReady && !pane.transcriptLoading && pane.composerReady),
        )
      );
    },
  });
  return () => {
    stopPrefetch();
    stopFavicon();
  };
}
