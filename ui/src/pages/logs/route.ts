import { definePage } from "@openclaw/uirouter";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("logs"),
  component: () =>
    import("./logs-page.tsx").then((module) => ({
      renderSolid: module.renderSolid,
    })),
});
