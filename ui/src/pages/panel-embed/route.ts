import { definePage } from "@openclaw/uirouter";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("panel-embed"),
  loader: async (_context, { location }) =>
    (await import("./target.ts")).parsePanelEmbedTarget(location.search),
  component: () => import("./route-entry.ts"),
});
