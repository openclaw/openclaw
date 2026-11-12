import { useApplication } from "../../lib/reactive/context.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { PluginsPageView } from "./plugins-page-view.tsx";
import { createPluginsPage } from "./plugins-page.ts";
import type { PluginsRouteData } from "./route-data.ts";
import "../../styles/carapace-control-ui.css";
import "../../styles/plugins.css";

type PluginsPageProps = { routeData?: PluginsRouteData; surface?: "discovery" | "settings" };

export function PluginsPage(props: PluginsPageProps) {
  let host!: HTMLElement;
  const context = useApplication();
  const theme = projectOwner(context.theme, (source) => ({
    catalog: source.catalog,
    mode: source.resolvedMode,
  }));
  const page = createPluginsPage({
    context,
    element: () => host,
    routeData: () => props.routeData,
    surface: () => props.surface ?? "settings",
  });
  return (
    <openclaw-plugins-page
      ref={(element) => {
        host = element;
      }}
    >
      <PluginsPageView
        page={page}
        themeCatalog={theme.read().catalog}
        themeMode={theme.read().mode}
        onRetryThemeCatalog={() => context.theme.retryCatalog?.()}
      />
    </openclaw-plugins-page>
  );
}
