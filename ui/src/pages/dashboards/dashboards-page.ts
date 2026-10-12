import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { DashboardsPage, type DashboardsPageProps } from "./dashboards-page.tsx";

defineSolidBridge<DashboardsPageProps>("openclaw-dashboards-page", DashboardsPage, {
  properties: { routeData: { default: undefined, attribute: false } },
});
