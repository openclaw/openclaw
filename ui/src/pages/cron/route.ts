import { definePage } from "@openclaw/uirouter";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("cron"),
  loaderDeps: (_context, { search }) => search,
  loader: (_context, { deps }) => deps,
  component: () => import("./cron-page.tsx").then((module) => module.cronPageComponent),
});
