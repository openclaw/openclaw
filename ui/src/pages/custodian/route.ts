import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { routePageSpec } from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-route-types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveOnboardingMode } from "../../app/onboarding-mode.ts";

export type CustodianRouteData = {
  onboarding: boolean;
  intent: "new-agent" | null;
};

export const page = definePage({
  ...routePageSpec("custodian"),
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) => location.search,
  loader: (_context: ApplicationContext, { location }): CustodianRouteData => ({
    onboarding: resolveOnboardingMode(location.search),
    intent: new URLSearchParams(location.search).get("intent") === "new-agent" ? "new-agent" : null,
  }),
  component: () =>
    import("./custodian-page.tsx").then((module) => ({
      header: true,
      renderSolid: (props: SolidRouteProps<CustodianRouteData>) =>
        createComponent(module.CustodianRoute, {
          get data() {
            return props.data;
          },
        }),
    })),
});
