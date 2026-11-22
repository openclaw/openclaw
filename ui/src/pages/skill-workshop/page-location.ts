import { routeIdFromPath } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { WorkshopViewerTarget } from "./view.tsx";

export function readWorkshopPage(context: ApplicationContext): { skill?: string; draft?: string } {
  const { pathname, search } = context.router.getState().location;
  if (routeIdFromPath(pathname, context.basePath) !== "skill-workshop") {
    return {};
  }
  const params = new URLSearchParams(search);
  return { skill: params.get("skill") ?? undefined, draft: params.get("draft") ?? undefined };
}

export function workshopPageSearch(target: WorkshopViewerTarget | undefined): string {
  if (!target) {
    return "";
  }
  return target.draftId
    ? `?draft=${encodeURIComponent(target.draftId)}`
    : `?skill=${encodeURIComponent(target.name)}`;
}
