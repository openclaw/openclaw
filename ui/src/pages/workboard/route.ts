import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { isValidWorkboardBoardId } from "@openclaw/workboard-contract";
import { html } from "lit";
import {
  pathForRoute,
  pathForWorkboardBoard,
  workboardBoardIdFromPath,
} from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { WORKBOARD_ALL_BOARDS_FILTER } from "./board-filter.ts";

export type WorkboardRouteData = {
  boardFilter: string;
  canonicalLocation?: RouteLocation;
  search: string;
};

export function resolveWorkboardRouteLocation(
  location: RouteLocation,
  basePath = "",
): WorkboardRouteData {
  const pathBoardId = workboardBoardIdFromPath(location.pathname, basePath);
  if (pathBoardId) {
    const params = new URLSearchParams(location.search);
    const hadLegacyBoard = params.has("board");
    params.delete("board");
    const search = params.toString();
    return {
      boardFilter: pathBoardId,
      search: search ? `?${search}` : "",
      ...(hadLegacyBoard
        ? {
            canonicalLocation: {
              pathname: pathForWorkboardBoard(pathBoardId, basePath),
              search: search ? `?${search}` : "",
              hash: location.hash,
            },
          }
        : {}),
    };
  }
  const params = new URLSearchParams(location.search);
  if (!params.has("board")) {
    return { boardFilter: WORKBOARD_ALL_BOARDS_FILTER, search: location.search };
  }
  const legacyBoardValue = params.get("board")?.trim() ?? "";
  params.delete("board");
  const search = params.toString();
  const boardFilter = isValidWorkboardBoardId(legacyBoardValue)
    ? legacyBoardValue
    : WORKBOARD_ALL_BOARDS_FILTER;
  return {
    boardFilter,
    search: search ? `?${search}` : "",
    canonicalLocation: {
      pathname:
        boardFilter === WORKBOARD_ALL_BOARDS_FILTER
          ? pathForRoute("workboard", basePath)
          : pathForWorkboardBoard(boardFilter, basePath),
      search: search ? `?${search}` : "",
      hash: location.hash,
    },
  };
}

async function loadWorkboardRoute(
  context: ApplicationContext,
  location: RouteLocation,
): Promise<WorkboardRouteData> {
  const sessions = context.sessions.state;
  await Promise.all([
    context.runtimeConfig.ensureLoaded(),
    context.agents.ensureList(),
    sessions.result || sessions.loading ? Promise.resolve() : context.sessions.refresh(),
  ]);
  return {
    ...resolveWorkboardRouteLocation(location, context.basePath),
  };
}

export const page = definePage({
  id: "workboard",
  path: "/workboard",
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) =>
    `${location.pathname}\u0000${location.search}`,
  loader: (context: ApplicationContext, { location }) => loadWorkboardRoute(context, location),
  component: () =>
    import("./workboard-page.ts").then(() => ({
      header: true,
      render: (data: WorkboardRouteData | undefined) =>
        html`<openclaw-workboard-page .routeData=${data}></openclaw-workboard-page>`,
    })),
});
