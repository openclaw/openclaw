/// <reference types="vite/client" />

import type { Route } from "./types.ts";

const routeModules = import.meta.glob<Route>("../pages/**/route.ts", {
  eager: true,
  import: "route",
});

export const pageRoutes: readonly Route[] = Object.values(routeModules);
