import { defineSolidPage } from "../../app-route-types.tsx";
import type { ApplicationContext } from "../../app/context.ts";
import { configTargetIdFromHash } from "../config/route-data.ts";

export const page = defineSolidPage<"profile", ApplicationContext, string | null>(
  "profile",
  () => import("./profile-page.tsx").then((module) => module.ProfilePage),
  {
    loaderDeps: (_context, location) => location.hash,
    loader: (context, { location }) => {
      // Warm the agents list so the hero identity renders without a flash.
      void context.agents.ensureList();
      return configTargetIdFromHash(location.hash);
    },
  },
);
