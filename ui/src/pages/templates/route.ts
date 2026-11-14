import { notFound, type RouteLocation } from "@openclaw/uirouter";
import {
  INTERNAL_TEMPLATES_PATH_PARAM,
  restoreBridgedRouteLocation,
} from "../../app-route-paths.ts";
import { defineSolidPage } from "../../app-route-types.tsx";
import type { ApplicationContext } from "../../app/context.ts";
import { isTemplatesAvailable } from "./availability.ts";

export type TemplatesRouteData = { location: RouteLocation; basePath: string };

export const page = defineSolidPage<"templates", ApplicationContext, TemplatesRouteData>(
  "templates",
  () => import("./page.tsx").then((module) => module.TemplatesPage),
  {
    loaderDeps: (context, location) => {
      const restored = restoreBridgedRouteLocation(location, INTERNAL_TEMPLATES_PATH_PARAM);
      return `${restored.pathname}${restored.search}:${isTemplatesAvailable(context.runtimeConfig.state)}`;
    },
    loader: async (context, { location }) => {
      await context.runtimeConfig.ensureLoaded();
      if (isTemplatesAvailable(context.runtimeConfig.state) === false) {
        return notFound();
      }
      return {
        location: restoreBridgedRouteLocation(location, INTERNAL_TEMPLATES_PATH_PARAM),
        basePath: context.basePath,
      };
    },
  },
);
