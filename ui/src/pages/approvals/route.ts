import { definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("approvals"),
  component: () =>
    import("./approvals-page.tsx").then((module) => ({
      header: true,
      renderSolid: () => createComponent(module.ApprovalsPage, {}),
    })),
});
