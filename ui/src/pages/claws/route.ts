import type { RouteLocation } from "@openclaw/uirouter";
import { INTERNAL_CLAWS_PATH_PARAM, restoreBridgedRouteLocation } from "../../app-route-paths.ts";
import { defineSolidPage } from "../../app-route-types.ts";
import type { ApplicationContext } from "../../app/context.ts";

export type ClawsRouteData = { location: RouteLocation; basePath: string };

export const page = defineSolidPage<"claws", ApplicationContext, ClawsRouteData>(
  "claws",
  () => import("./page.tsx").then((module) => module.ClawsPage),
  {
    loaderDeps: (_context: ApplicationContext, location) =>
      restoreBridgedRouteLocation(location, INTERNAL_CLAWS_PATH_PARAM).pathname,
    loader: (context: ApplicationContext, options): ClawsRouteData => ({
      location: restoreBridgedRouteLocation(options.location, INTERNAL_CLAWS_PATH_PARAM),
      basePath: context.basePath,
    }),
  },
);
