import type { ApplicationRouter, RouteId } from "../app-routes.ts";
import { selectRenderedRouteMatch } from "../app/router-outlet-controller.ts";

export type ContextualSidebar = {
  key: RouteId;
  data: unknown;
  loaderPending: boolean;
  render: (data: unknown, loaderPending: boolean, presented?: boolean) => unknown;
};

/** Both page and sidebar consume the router owner's same rendered match. */
export function selectSidebarContext(
  state: ReturnType<ApplicationRouter["getState"]>,
): ContextualSidebar | undefined {
  const match = selectRenderedRouteMatch(state.matches[0], state.pendingMatches[0]);
  const render = match?.module?.renderSidebar;
  return match &&
    (match.status === "success" || match.status === "pending") &&
    match.error === undefined &&
    typeof render === "function"
    ? { key: match.routeId, data: match.data, loaderPending: match.isFetching === "loader", render }
    : undefined;
}

export function equalSidebarContext(
  previous: ContextualSidebar | undefined,
  next: ContextualSidebar | undefined,
): boolean {
  return (
    previous?.key === next?.key &&
    previous?.data === next?.data &&
    previous?.loaderPending === next?.loaderPending &&
    previous?.render === next?.render
  );
}
