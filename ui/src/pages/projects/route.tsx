import { definePage } from "@openclaw/uirouter";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("projects"),
  component: () => import("./projects-page.tsx").then((module) => module.projectsRouteView),
});
