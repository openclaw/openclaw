import { lazy, Loading } from "solid-js";
import type { SolidRouteProps } from "../../app-route-types.tsx";

export const CronPage = lazy(() => import("./cron-page.tsx"), { export: "CronPage" });

export function renderSolid(props: SolidRouteProps) {
  return (
    <Loading>
      <CronPage routeSearch={typeof props.data === "string" ? props.data : ""} />
    </Loading>
  );
}
