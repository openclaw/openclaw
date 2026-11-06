import { defineSolidPage } from "../../app-route-types.tsx";
import type { ApplicationContext } from "../../app/context.ts";

export const page = defineSolidPage(
  "profile",
  () => import("./profile-page.tsx").then((module) => module.ProfilePage),
  {
    loader: (context: ApplicationContext) => {
      // Warm the agents list so the hero identity renders without a flash.
      void context.agents.ensureList();
    },
  },
);
