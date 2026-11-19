import type { RouteLocation } from "@openclaw/uirouter";
import type { SolidRouteProps } from "../../app-route-types.tsx";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { ActivityPage } from "./activity-page.tsx";

export function renderSolid(props: SolidRouteProps<RouteLocation>) {
  return (
    <ShellLayoutBoundary traits={{ activityPage: true, settingsWorkspace: true }}>
      <ActivityPage routeLocation={props.data} />
    </ShellLayoutBoundary>
  );
}
