import { notFound, type RouteLocation } from "@openclaw/uirouter";
import { INTERNAL_CLAWS_PATH_PARAM, restoreBridgedRouteLocation } from "../../app-route-paths.ts";
import { defineSolidPage } from "../../app-route-types.tsx";
import type { ApplicationContext } from "../../app/context.ts";
import { isClawsAvailable } from "./availability.ts";

export type ClawsRouteData = { location: RouteLocation; basePath: string };

export const page = defineSolidPage<"claws", ApplicationContext, ClawsRouteData>(
  "claws",
  () => import("./page.tsx").then((module) => module.ClawsPage),
  {
    loaderDeps: (context, location) => {
      const restored = restoreBridgedRouteLocation(location, INTERNAL_CLAWS_PATH_PARAM);
      return `${restored.pathname}${restored.search}:${isClawsAvailable(context.runtimeConfig.state)}`;
    },
    loader: async (context, { location }) => {
      await context.runtimeConfig.ensureLoaded();
      if (isClawsAvailable(context.runtimeConfig.state) === false) {
        return notFound();
      }
      return {
        location: restoreBridgedRouteLocation(location, INTERNAL_CLAWS_PATH_PARAM),
        basePath: context.basePath,
      };
    },
  },
);
