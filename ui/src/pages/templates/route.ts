import { notFound, type RouteLocation } from "@openclaw/uirouter";
import {
  INTERNAL_TEMPLATES_PATH_PARAM,
  restoreBridgedRouteLocation,
} from "../../app-route-paths.ts";
import { defineSolidPage } from "../../app-route-types.tsx";
import type { ApplicationContext } from "../../app/context.ts";
import { isTemplatesAvailable } from "./availability.ts";
import {
  beginTemplateDetailRead,
  templateRouteSource,
  type TemplateDetailRead,
} from "./detail-read.ts";
import { templateDraftTargetFromSearch } from "./draft-navigation.ts";

export type TemplatesRouteData = {
  location: RouteLocation;
  basePath: string;
  initialDetail?: TemplateDetailRead;
};

export const page = defineSolidPage<"templates", ApplicationContext, TemplatesRouteData>(
  "templates",
  () => import("./page.tsx").then((module) => module.TemplatesPage),
  {
    loaderDeps: (context, location) => {
      const restored = restoreBridgedRouteLocation(location, INTERNAL_TEMPLATES_PATH_PARAM);
      const available = isTemplatesAvailable(context.runtimeConfig.state);
      // A direct document starts on a bridged URL while config may still be loading.
      // Resolving that same entry to enabled isn't another visit; a known denial still is distinct.
      const gate = templateRouteSource(restored, context.basePath)
        ? available !== false
        : available;
      return `${restored.pathname}${restored.search}:${gate}`;
    },
    // Returning to a release needs a fresh access check, not a cached loader receipt.
    gcTime: 0,
    loader: async (context, options) => {
      if (isTemplatesAvailable(context.runtimeConfig.state) === null) {
        await context.runtimeConfig.ensureDisplayLoaded();
      }
      if (isTemplatesAvailable(context.runtimeConfig.state) === false) {
        return notFound();
      }
      const location = restoreBridgedRouteLocation(options.location, INTERNAL_TEMPLATES_PATH_PARAM);
      const data: TemplatesRouteData = { location, basePath: context.basePath };
      // Start the admitted foreground read alongside the lazy renderer, never on a hover or draft link.
      if (
        options.cause === "navigation" &&
        options.shouldRun() &&
        !options.signal.aborted &&
        isTemplatesAvailable(context.runtimeConfig.state) === true &&
        !templateDraftTargetFromSearch(location.search)
      ) {
        const source = templateRouteSource(location, context.basePath);
        if (source) {
          data.initialDetail = beginTemplateDetailRead(context.gateway, source);
        }
      }
      return data;
    },
  },
);
