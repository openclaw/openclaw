import { definePage, notFound, type RouteLocation } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import {
  INTERNAL_CLAWS_PATH_PARAM,
  restoreBridgedRouteLocation,
  routePageSpec,
} from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-route-types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { isClawsAvailable } from "./availability.ts";

export type ClawsRouteData = { location: RouteLocation; basePath: string };

export const page = definePage({
  ...routePageSpec("claws"),
  loaderDeps: (context: ApplicationContext, location) =>
    `${restoreBridgedRouteLocation(location, INTERNAL_CLAWS_PATH_PARAM).pathname}:${isClawsAvailable(context.runtimeConfig.state)}`,
  loader: async (context: ApplicationContext, options) => {
    await context.runtimeConfig.ensureLoaded();
    if (isClawsAvailable(context.runtimeConfig.state) === false) {
      return notFound();
    }
    return {
      location: restoreBridgedRouteLocation(options.location, INTERNAL_CLAWS_PATH_PARAM),
      basePath: context.basePath,
    } satisfies ClawsRouteData;
  },
  component: () =>
    import("./page.tsx").then((module) => ({
      header: true,
      renderSolid: (props: SolidRouteProps<ClawsRouteData>) =>
        createComponent(module.ClawsPage, {
          get routeData() {
            return props.data;
          },
        }),
    })),
});
