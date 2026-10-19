import { definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("secrets"),
  component: () =>
    import("./secrets-page.tsx").then((module) => ({
      header: true,
      renderSolid: () => createComponent(module.SecretsPage, {}),
    })),
});
