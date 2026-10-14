import { definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";

export const page = definePage({
  ...routePageSpec("profile"),
  loader: (context: ApplicationContext) => {
    // Warm the agents list so the hero identity renders without a flash.
    void context.agents.ensureList();
  },
  component: () =>
    import("./profile-page.tsx").then((module) => ({
      header: true,
      renderSolid: () => createComponent(module.ProfilePage, {}),
    })),
});
