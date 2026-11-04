import { createRouter, definePage } from "@openclaw/uirouter";
import { onTestFinished } from "vitest";
import type { ApplicationRouter, RouteId } from "../app-routes.ts";

type RouteModule = NonNullable<
  ReturnType<ApplicationRouter["getState"]>["matches"][number]["module"]
>;

export function createSidebarTestRouter(
  renderSidebar: NonNullable<RouteModule["renderSidebar"]> = () => null,
) {
  const router = createRouter<RouteId, unknown, RouteModule>({
    routes: [
      definePage({
        id: "systems",
        path: "/systems",
        component: () => ({ renderSolid: () => null, renderSidebar }),
      }),
      definePage({ id: "cron", path: "/cron", component: () => ({ renderSolid: () => null }) }),
    ],
  });
  onTestFinished(() => router.stop());
  return router;
}
