import { definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("debug"),
  component: () =>
    import("./debug-page.tsx").then((module) => ({
      header: true,
      renderSolid: () => createComponent(module.DebugPage, {}),
    })),
});
