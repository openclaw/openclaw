import { definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("portals"),
  component: () =>
    import("./portals-page.tsx").then((module) => ({
      header: true,
      renderSolid: () => createComponent(module.PortalsPage, {}),
    })),
});
