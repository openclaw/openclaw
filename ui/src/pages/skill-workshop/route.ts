import { definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("skill-workshop"),
  component: () =>
    import("./skill-workshop-page.tsx").then((module) => ({
      renderSolid: () => createComponent(module.SkillWorkshopPage, {}),
    })),
});
